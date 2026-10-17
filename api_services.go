package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"net/http"
)

type LaunchdService struct {
	Label     string `json:"label"`
	Domain    string `json:"domain"` // user | agent | daemon
	PlistPath string `json:"plist_path"`
	Running   bool   `json:"running"`
	PID       int    `json:"pid"`
	LastExit  *int   `json:"last_exit"`
	Program   string `json:"program"`
	KeepAlive bool   `json:"keep_alive"`
	RunAtLoad bool   `json:"run_at_load"`
	Disabled  bool   `json:"disabled"`
}

// parsePlist converts a plist to JSON via plutil, cached by path+mtime: each
// miss spawns a plutil process (~0.2s for a full scan of 36 plists), while
// plist contents change rarely. Callers only read the returned map.
var (
	plistMu    sync.Mutex
	plistCache = map[string]plistEntry{}
)

type plistEntry struct {
	modTime time.Time
	data    map[string]any
}

func parsePlist(path string) map[string]any {
	st, err := os.Stat(path)
	if err != nil {
		return nil
	}
	plistMu.Lock()
	if e, ok := plistCache[path]; ok && e.modTime.Equal(st.ModTime()) {
		plistMu.Unlock()
		return e.data
	}
	plistMu.Unlock()
	out, err := exec.Command("plutil", "-convert", "json", "-o", "-", path).Output()
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(out, &m) != nil {
		return nil
	}
	plistMu.Lock()
	plistCache[path] = plistEntry{modTime: st.ModTime(), data: m}
	plistMu.Unlock()
	return m
}

func plistBool(m map[string]any, key string) bool {
	if v, ok := m[key]; ok {
		switch t := v.(type) {
		case bool:
			return t
		case map[string]any:
			return true
		}
	}
	return false
}

func launchdState() map[string][2]string {
	// label -> [pid, lastExit]
	out, _ := exec.Command("launchctl", "list").CombinedOutput()
	st := map[string][2]string{}
	for _, line := range strings.Split(string(out), "\n")[1:] {
		f := strings.Fields(line)
		if len(f) >= 3 {
			st[f[2]] = [2]string{f[0], f[1]}
		}
	}
	return st
}

// GET /api/services/launchd
func (app *App) handleLaunchdList(w http.ResponseWriter, r *http.Request, s *Session) {
	uid := os.Getuid()
	_ = uid
	state := launchdState()
	services := []LaunchdService{}
	dirs := []struct {
		path   string
		domain string
	}{
		{filepath.Join(homeDir(), "Library", "LaunchAgents"), "user"},
		{"/Library/LaunchAgents", "agent"},
		{"/Library/LaunchDaemons", "daemon"},
	}
	for _, d := range dirs {
		entries, err := os.ReadDir(d.path)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".plist") {
				continue
			}
			full := filepath.Join(d.path, e.Name())
			m := parsePlist(full)
			if m == nil {
				continue
			}
			label, _ := m["Label"].(string)
			if label == "" {
				label = strings.TrimSuffix(e.Name(), ".plist")
			}
			ls := LaunchdService{
				Label:     label,
				Domain:    d.domain,
				PlistPath: full,
				KeepAlive: plistBool(m, "KeepAlive"),
				RunAtLoad: plistBool(m, "RunAtLoad"),
				Disabled:  plistBool(m, "Disabled"),
			}
			if prog, ok := m["Program"].(string); ok {
				ls.Program = prog
			} else if args, ok := m["ProgramArguments"].([]any); ok && len(args) > 0 {
				ls.Program, _ = args[0].(string)
			}
			if st, ok := state[label]; ok {
				if st[0] != "-" {
					ls.Running = true
					ls.PID, _ = strconv.Atoi(st[0])
				}
				if st[1] != "-" && st[1] != "0" {
					v, _ := strconv.Atoi(st[1])
					ls.LastExit = &v
				}
			}
			services = append(services, ls)
		}
	}
	apiOK(w, map[string]any{"services": services})
}

// POST /api/services/launchd/action {label, action: start|stop|restart}
func (app *App) handleLaunchdAction(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		Label  string `json:"label"`
		Action string `json:"action"`
	}
	if err := readJSON(r, &req); err != nil || req.Label == "" {
		apiErr(w, 400, "Invalid request")
		return
	}
	// only the user domain may be operated on (plus /Library/LaunchAgents entries usable in the gui domain)
	plistPath := ""
	for _, svc := range app.launchdCached() {
		if svc.Label == req.Label {
			plistPath = svc.PlistPath
			if svc.Domain != "user" && svc.Domain != "agent" {
				apiErr(w, http.StatusForbidden, "System-level services require root; the panel only manages user-level services")
				return
			}
		}
	}
	if plistPath == "" {
		apiErr(w, 404, "Service not found")
		return
	}
	target := "gui/" + strconv.Itoa(os.Getuid()) + "/" + req.Label
	var out string
	var code int
	switch req.Action {
	case "restart":
		out, code = runCmd(0, "launchctl", "kickstart", "-k", target)
	case "start":
		out, code = runCmd(0, "launchctl", "kickstart", target)
		if code != 0 {
			// possibly not loaded yet; try bootstrap
			out2, code2 := runCmd(0, "launchctl", "bootstrap", "gui/"+strconv.Itoa(os.Getuid()), plistPath)
			if code2 == 0 {
				out, code = out2, code2
			}
		}
	case "stop":
		out, code = runCmd(0, "launchctl", "bootout", target)
	default:
		apiErr(w, 400, "Unknown action")
		return
	}
	app.audit("launchd_"+req.Action, req.Label)
	if code != 0 {
		apiErr(w, 500, "Action failed: "+strings.TrimSpace(out))
		return
	}
	apiOK(w, map[string]any{"output": strings.TrimSpace(out)})
}

// launchdCached rescans live state; plist parsing is cached by parsePlist
func (app *App) launchdCached() []LaunchdService {
	state := launchdState()
	services := []LaunchdService{}
	dirs := []struct {
		path   string
		domain string
	}{
		{filepath.Join(homeDir(), "Library", "LaunchAgents"), "user"},
		{"/Library/LaunchAgents", "agent"},
		{"/Library/LaunchDaemons", "daemon"},
	}
	for _, d := range dirs {
		entries, err := os.ReadDir(d.path)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".plist") {
				continue
			}
			full := filepath.Join(d.path, e.Name())
			m := parsePlist(full)
			if m == nil {
				continue
			}
			label, _ := m["Label"].(string)
			if label == "" {
				label = strings.TrimSuffix(e.Name(), ".plist")
			}
			ls := LaunchdService{Label: label, Domain: d.domain, PlistPath: full}
			if st, ok := state[label]; ok && st[0] != "-" {
				ls.Running = true
			}
			services = append(services, ls)
		}
	}
	return services
}

// ---------- brew services ----------

const brewListTTL = 30 * time.Second

// brewServicesList runs `brew services list` with a short-TTL cache: the brew
// binary is a ruby startup costing ~0.5–2s, and both the Services page (polled
// every 10s) and the Sites page (caddy status) would otherwise pay it each time
func (app *App) brewServicesList() (string, int) {
	app.brewMu.Lock()
	defer app.brewMu.Unlock()
	if time.Since(app.brewAt) < brewListTTL {
		return app.brewOut, app.brewCode
	}
	out, code := runCmd(60*time.Second, brewBin(), "services", "list")
	if code == 0 { // only cache successes; a transient failure shouldn't stick
		app.brewOut, app.brewCode, app.brewAt = out, code, time.Now()
	}
	return out, code
}

// invalidateBrewList drops the cached brew services output so the next read is live
func (app *App) invalidateBrewList() {
	app.brewMu.Lock()
	app.brewAt = time.Time{}
	app.brewMu.Unlock()
}

type BrewService struct {
	Name    string `json:"name"`
	Status  string `json:"status"`
	User    string `json:"user"`
	File    string `json:"file"`
	Running bool   `json:"running"`
}

// GET /api/services/brew
func (app *App) handleBrewServices(w http.ResponseWriter, r *http.Request, s *Session) {
	out, code := app.brewServicesList()
	if code != 0 {
		apiErr(w, 500, "brew services failed: "+out)
		return
	}
	list := []BrewService{}
	lines := strings.Split(out, "\n")
	for i, line := range lines {
		if i == 0 || strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		bs := BrewService{Name: f[0], Status: f[1]}
		if len(f) >= 3 {
			bs.User = f[2]
		}
		if len(f) >= 4 {
			bs.File = f[3]
		}
		bs.Running = bs.Status == "started"
		list = append(list, bs)
	}
	apiOK(w, map[string]any{"services": list})
}

// POST /api/services/brew/action {name, action}
func (app *App) handleBrewServiceAction(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		Name   string `json:"name"`
		Action string `json:"action"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	switch req.Action {
	case "start", "stop", "restart", "run":
	default:
		apiErr(w, 400, "Unknown action")
		return
	}
	if !safeName(req.Name) {
		apiErr(w, 400, "Invalid name")
		return
	}
	out, code := runCmd(120*time.Second, brewBin(), "services", req.Action, req.Name)
	app.audit("brew_service_"+req.Action, req.Name)
	app.invalidateBrewList()
	if code != 0 {
		apiErr(w, 500, strings.TrimSpace(out))
		return
	}
	apiOK(w, map[string]any{"output": strings.TrimSpace(out)})
}

func safeName(s string) bool {
	if s == "" || len(s) > 100 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == '@' || c == '/' || c == '+') {
			return false
		}
	}
	return true
}

func brewBin() string {
	for _, p := range []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"} {
		if fileExists(p) {
			return p
		}
	}
	return "brew"
}
