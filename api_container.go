package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const containerBin = "/usr/local/bin/container"

func containerBinPath() string {
	for _, p := range []string{"/usr/local/bin/container", "/opt/homebrew/bin/container"} {
		if fileExists(p) {
			return p
		}
	}
	return "container"
}

// fields of `container ls --format json` (only what we need)
type ContainerRow struct {
	ID     string `json:"id"`
	Status struct {
		State       string `json:"state"`
		StartedDate string `json:"startedDate"`
		Networks    []struct {
			IPv4Address string `json:"ipv4Address"`
		} `json:"networks"`
	} `json:"status"`
	Configuration struct {
		Image struct {
			Reference string `json:"reference"`
		} `json:"image"`
		Resources struct {
			CPUs  int   `json:"cpus"`
			MemMB int64 `json:"memoryInBytes"`
		} `json:"resources"`
		PublishedPorts []struct {
			HostPort      int    `json:"hostPort"`
			ContainerPort int    `json:"containerPort"`
			HostAddress   string `json:"hostAddress"`
			Proto         string `json:"proto"`
		} `json:"publishedPorts"`
	} `json:"configuration"`
}

type ContainerInfo struct {
	ID      string   `json:"id"`
	Image   string   `json:"image"`
	State   string   `json:"state"`
	IP      string   `json:"ip"`
	Ports   []string `json:"ports"`
	CPUs    int      `json:"cpus"`
	MemMB   int64    `json:"mem_mb"`
	Started string   `json:"started"`
}

// GET /api/container/list
func (app *App) handleContainerList(w http.ResponseWriter, r *http.Request, s *Session) {
	out, code := runCmd(30*time.Second, containerBinPath(), "ls", "--all", "--format", "json")
	if code != 0 {
		// older versions may not support --all
		out, code = runCmd(30*time.Second, containerBinPath(), "ls", "--format", "json")
		if code != 0 {
			apiErr(w, 500, "container ls failed: "+strings.TrimSpace(out))
			return
		}
	}
	rows := []ContainerRow{}
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		apiErr(w, 500, "Failed to parse container output: "+err.Error())
		return
	}
	list := []ContainerInfo{}
	for _, row := range rows {
		ci := ContainerInfo{
			ID:      row.ID,
			Image:   row.Configuration.Image.Reference,
			State:   row.Status.State,
			CPUs:    row.Configuration.Resources.CPUs,
			MemMB:   row.Configuration.Resources.MemMB / 1024 / 1024,
			Started: row.Status.StartedDate,
		}
		if len(row.Status.Networks) > 0 {
			ci.IP = row.Status.Networks[0].IPv4Address
		}
		for _, p := range row.Configuration.PublishedPorts {
			ci.Ports = append(ci.Ports, p.HostAddress+":"+itoa(p.HostPort)+"→"+itoa(p.ContainerPort))
		}
		list = append(list, ci)
	}
	apiOK(w, map[string]any{"containers": list})
}

// POST /api/container/action {id, action: start|stop|restart|delete}
func (app *App) handleContainerAction(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		ID     string `json:"id"`
		Action string `json:"action"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	if !safeName(req.ID) {
		apiErr(w, 400, "Invalid container name")
		return
	}
	var args []string
	switch req.Action {
	case "start":
		args = []string{"start", req.ID}
	case "stop":
		args = []string{"stop", req.ID}
	case "restart":
		args = []string{"stop", req.ID}
	case "delete":
		if r.Header.Get("X-Panel-Confirm") != "yes" {
			apiErr(w, 400, "Missing confirmation header")
			return
		}
		args = []string{"delete", "--force", req.ID}
	default:
		apiErr(w, 400, "Unknown action")
		return
	}
	if req.Action == "restart" {
		_, code := runCmd(60*time.Second, containerBinPath(), args...)
		if code != 0 {
			apiErr(w, 500, "Failed to stop container")
			return
		}
		args = []string{"start", req.ID}
	}
	out, code := runCmd(120*time.Second, containerBinPath(), args...)
	app.audit("container_"+req.Action, req.ID)
	if code != 0 {
		apiErr(w, 500, strings.TrimSpace(out))
		return
	}
	apiOK(w, map[string]any{"output": strings.TrimSpace(out)})
}

// GET /api/container/logs?id=xxx&tail=200
func (app *App) handleContainerLogs(w http.ResponseWriter, r *http.Request, s *Session) {
	id := r.URL.Query().Get("id")
	if !safeName(id) {
		apiErr(w, 400, "Invalid container name")
		return
	}
	out, code := runCmd(30*time.Second, containerBinPath(), "logs", id)
	if code != 0 && strings.TrimSpace(out) == "" {
		apiErr(w, 500, "Failed to get logs")
		return
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) > 500 {
		lines = lines[len(lines)-500:]
	}
	apiOK(w, map[string]any{"logs": lines})
}

// fields of `container image ls --format json` (only what we need; the raw
// output embeds the full image config and layer history)
type imageVariant struct {
	Platform struct {
		Architecture string `json:"architecture"`
		OS           string `json:"os"`
		Variant      string `json:"variant"`
	} `json:"platform"`
	Size int64 `json:"size"`
}

type imageRow struct {
	Configuration struct {
		Name         string `json:"name"`
		CreationDate string `json:"creationDate"`
	} `json:"configuration"`
	ID       string         `json:"id"`
	Variants []imageVariant `json:"variants"`
}

// GET /api/container/images
func (app *App) handleContainerImages(w http.ResponseWriter, r *http.Request, s *Session) {
	// container CLI 1.5.0 renamed `images ls` to `image ls`; try new first
	out, code := runCmd(30*time.Second, containerBinPath(), "image", "ls", "--format", "json")
	if code != 0 {
		out, code = runCmd(30*time.Second, containerBinPath(), "images", "ls", "--format", "json")
	}
	if code != 0 {
		apiErr(w, 500, strings.TrimSpace(out))
		return
	}
	var rows []imageRow
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		apiErr(w, 500, "Failed to parse image output: "+err.Error())
		return
	}
	imgs := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		v := map[string]any{
			"name":    row.Configuration.Name,
			"id":      row.ID,
			"created": row.Configuration.CreationDate,
		}
		if len(row.Variants) > 0 {
			v["size"] = row.Variants[0].Size
			arch := row.Variants[0].Platform.Architecture + "/" + row.Variants[0].Platform.OS
			if vr := row.Variants[0].Platform.Variant; vr != "" {
				arch += "/" + vr
			}
			v["arch"] = arch
		}
		imgs = append(imgs, v)
	}
	apiOK(w, map[string]any{"images": imgs})
}

// POST /api/container/run {name, image, ports:["8080:80"], env:["K=V"], mounts:["/host:/cont"]}
func (app *App) handleContainerRun(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		Name   string   `json:"name"`
		Image  string   `json:"image"`
		Ports  []string `json:"ports"`
		Env    []string `json:"env"`
		Mounts []string `json:"mounts"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	if !safeName(req.Name) || req.Image == "" || strings.ContainsAny(req.Image, ";|&$`") {
		apiErr(w, 400, "Invalid parameters")
		return
	}
	args := []string{"run", "-d", "--name", req.Name}
	for _, p := range req.Ports {
		if !safePortMap(p) {
			apiErr(w, 400, "Invalid port mapping: "+p)
			return
		}
		args = append(args, "-p", p)
	}
	for _, e := range req.Env {
		if !safeEnv(e) {
			apiErr(w, 400, "Invalid environment variable: "+e)
			return
		}
		args = append(args, "-e", e)
	}
	for _, m := range req.Mounts {
		if !safeMount(m) {
			apiErr(w, 400, "Invalid mount: "+m)
			return
		}
		args = append(args, "-v", m)
	}
	args = append(args, req.Image)
	j := app.jobs.Start("container run "+req.Name, append([]string{containerBinPath()}, args...)...)
	app.audit("container_run", req.Name+" "+req.Image)
	apiOK(w, map[string]any{"job_id": j.ID})
}

func safePortMap(s string) bool {
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return false
	}
	for _, p := range parts {
		if len(p) == 0 || len(p) > 5 {
			return false
		}
		for _, c := range p {
			if c < '0' || c > '9' {
				return false
			}
		}
	}
	return true
}

func safeEnv(s string) bool {
	i := strings.Index(s, "=")
	if i <= 0 {
		return false
	}
	for _, c := range s {
		if c == '\n' || c == '\r' || c == 0 {
			return false
		}
	}
	return true
}

func safeMount(s string) bool {
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return false
	}
	for _, p := range parts {
		if p == "" || strings.HasPrefix(p, "-") {
			return false
		}
		for _, c := range p {
			if c == ';' || c == '|' || c == '&' || c == '`' {
				return false
			}
		}
	}
	return true
}

func itoa(i int) string {
	return fmt.Sprintf("%d", i)
}
