package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

var dataDir string

type App struct {
	store    *Store
	sessions *SessionManager
	limiter  *RateLimiter
	sampler  *Sampler
	jobs     *JobManager

	// brew services list spawns the ruby-based brew binary (~0.5–2s), so its
	// output is cached briefly; invalidated on any action that changes state
	brewMu   sync.Mutex
	brewOut  string
	brewCode int
	brewAt   time.Time
}

func main() {
	defaultDir := filepath.Join(homeDir(), "macpanel", "data")
	var cfgDir = flag.String("data", defaultDir, "data directory")
	flag.Parse()
	dataDir = *cfgDir
	_ = os.MkdirAll(dataDir, 0o700)

	store, err := LoadStore(dataDir)
	if err != nil {
		log.Fatal("failed to load config: ", err)
	}
	app := &App{
		store:    store,
		sessions: NewSessions(filepath.Join(dataDir, "sessions.json")),
		limiter:  NewRateLimiter(),
		sampler:  NewSampler(),
		jobs:     NewJobs(),
	}
	app.sessions.Load()
	app.sampler.Start(5 * time.Second)
	go app.monitorLoop(60 * time.Second)

	mux := http.NewServeMux()

	// Public: setup status + setup + login
	mux.HandleFunc("/api/setup-status", app.handleSetupStatus)
	mux.HandleFunc("/api/setup", app.handleSetup)
	mux.HandleFunc("/api/login", app.handleLogin)

	// Requires login
	mux.HandleFunc("/api/me", app.authWrap(app.handleMe))
	mux.HandleFunc("/api/logout", app.authWrap(app.handleLogout))
	mux.HandleFunc("/api/system/status", app.authWrap(app.handleStatus))
	mux.HandleFunc("/api/system/history", app.authWrap(app.handleHistory))
	mux.HandleFunc("/api/system/ports", app.authWrap(app.handlePorts))
	mux.HandleFunc("/api/system/ports/favorite", app.authWrap(app.handlePortFavorite))
	mux.HandleFunc("/api/system/probe", app.authWrap(app.handleProbe))
	mux.HandleFunc("/api/services/launchd", app.authWrap(app.handleLaunchdList))
	mux.HandleFunc("/api/services/launchd/action", app.authWrap(app.handleLaunchdAction))
	mux.HandleFunc("/api/services/brew", app.authWrap(app.handleBrewServices))
	mux.HandleFunc("/api/services/brew/action", app.authWrap(app.handleBrewServiceAction))
	mux.HandleFunc("/api/monitors", app.authWrap(app.handleMonitorList))
	mux.HandleFunc("/api/monitors/add", app.authWrap(app.handleMonitorAdd))
	mux.HandleFunc("/api/monitors/delete", app.authWrap(app.handleMonitorDelete))
	mux.HandleFunc("/api/monitors/toggle", app.authWrap(app.handleMonitorToggle))
	mux.HandleFunc("/api/monitors/check", app.authWrap(app.handleMonitorCheck))
	mux.HandleFunc("/api/monitors/action", app.authWrap(app.handleMonitorAction))
	mux.HandleFunc("/api/cron", app.authWrap(app.handleCronList))
	mux.HandleFunc("/api/cron/toggle", app.authWrap(app.handleCronToggle))
	mux.HandleFunc("/api/cron/save", app.authWrap(app.handleCronSave))
	mux.HandleFunc("/api/cron/delete", app.authWrap(app.handleCronDelete))
	mux.HandleFunc("/api/brew/installed", app.authWrap(app.handleBrewInstalled))
	mux.HandleFunc("/api/brew/search", app.authWrap(app.handleBrewSearch))
	mux.HandleFunc("/api/brew/info", app.authWrap(app.handleBrewInfo))
	mux.HandleFunc("/api/brew/action", app.authWrap(app.handleBrewAction))
	mux.HandleFunc("/api/container/list", app.authWrap(app.handleContainerList))
	mux.HandleFunc("/api/container/action", app.authWrap(app.handleContainerAction))
	mux.HandleFunc("/api/container/logs", app.authWrap(app.handleContainerLogs))
	mux.HandleFunc("/api/container/images", app.authWrap(app.handleContainerImages))
	mux.HandleFunc("/api/container/run", app.authWrap(app.handleContainerRun))
	mux.HandleFunc("/api/sites", app.authWrap(app.handleSiteList))
	mux.HandleFunc("/api/sites/save", app.authWrap(app.handleSiteSave))
	mux.HandleFunc("/api/sites/delete", app.authWrap(app.handleSiteDelete))
	mux.HandleFunc("/api/sites/caddy", app.authWrap(app.handleCaddyAction))
	mux.HandleFunc("/api/links", app.authWrap(app.handleLinkList))
	mux.HandleFunc("/api/links/save", app.authWrap(app.handleLinkSave))
	mux.HandleFunc("/api/links/delete", app.authWrap(app.handleLinkDelete))
	mux.HandleFunc("/api/links/move", app.authWrap(app.handleLinkMove))
	mux.HandleFunc("/api/termcmds", app.authWrap(app.handleTermCmdList))
	mux.HandleFunc("/api/termcmds/save", app.authWrap(app.handleTermCmdSave))
	mux.HandleFunc("/api/termcmds/delete", app.authWrap(app.handleTermCmdDelete))
	mux.HandleFunc("/api/termcmds/move", app.authWrap(app.handleTermCmdMove))
	mux.HandleFunc("/api/apps", app.authWrap(app.handleAppList))
	mux.HandleFunc("/api/apps/install-brew", app.authWrap(app.handleAppInstallBrew))
	mux.HandleFunc("/api/apps/install-container", app.authWrap(app.handleAppInstallContainer))
	mux.HandleFunc("/api/jobs", app.authWrap(app.handleJobList))
	mux.HandleFunc("/api/jobs/", app.authWrap(app.handleJobGet))
	mux.HandleFunc("/api/ai/settings", app.authWrap(app.handleAIGet))
	mux.HandleFunc("/api/ai/settings/save", app.authWrap(app.handleAISet))
	mux.HandleFunc("/api/ai/chat", app.authWrap(app.handleAIChat))
	mux.HandleFunc("/api/audit", app.authWrap(app.handleAudit))
	mux.HandleFunc("/api/settings", app.authWrap(app.handleSettingsGet))
	mux.HandleFunc("/api/settings/save", app.authWrap(app.handleSettingsSave))
	mux.HandleFunc("/api/password", app.authWrap(app.handlePasswordChange))
	mux.HandleFunc("/api/terminal", app.authWrap(app.handleTerminal))

	// Static assets (public; the SPA shell is guarded by the entrance middleware); URL /assets/* maps to web/assets/*
	assets, _ := fs.Sub(webFS, "web/assets")
	fileServer := http.FileServer(http.FS(assets))
	mux.Handle("/assets/", http.StripPrefix("/assets/", fileServer))

	// SPA entry point (includes the entrance gate)
	mux.HandleFunc("/", app.spaHandler(fileServer))

	handler := securityHeaders(cacheControl(mux))

	listen := store.Cfg.Listen
	if listen == "" {
		listen = ":9000"
	}
	tlsOn := store.Cfg.TLSCert != "" && store.Cfg.TLSKey != ""
	if tlsOn && store.Cfg.HTTPPort != "" {
		go func() {
			redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				host := r.Host
				target := "https://" + host + r.RequestURI
				http.Redirect(w, r, target, http.StatusMovedPermanently)
			})
			log.Println("HTTP redirect listening on", store.Cfg.HTTPPort)
			log.Println(http.ListenAndServe(store.Cfg.HTTPPort, securityHeaders(redirect)))
		}()
	}
	srv := &http.Server{
		Addr:              listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("MacPanel started on %s (TLS=%v)", listen, tlsOn)
	if tlsOn {
		log.Fatal(srv.ListenAndServeTLS(store.Cfg.TLSCert, store.Cfg.TLSKey))
	} else {
		log.Fatal(srv.ListenAndServe())
	}
}

// cacheControl guards against browsers reusing stale caches after an upgrade: API and SPA shell are no-store, static assets must revalidate
func cacheControl(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// spaHandler: entrance gate + SPA shell
func (app *App) spaHandler(assets http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		entrance := app.store.Cfg.Entrance
		if entrance != "" {
			// API paths are guarded by their own auth checks, not intercepted here
			if !strings.HasPrefix(p, "/api/") && !strings.HasPrefix(p, "/assets/") {
				if p != "/"+entrance && !strings.HasPrefix(p, "/"+entrance+"/") {
					// 404 instead of 302: don't reveal the entrance's existence to scanners
					http.NotFound(w, r)
					return
				}
			}
		}
		// All other paths fall back to the SPA
		b, err := webFS.ReadFile("web/index.html")
		if err != nil {
			http.Error(w, "panel shell missing", 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(b)
	}
}

// handleSettingsGet reads the current security settings (excluding password hashes)
func (app *App) handleSettingsGet(w http.ResponseWriter, r *http.Request, s *Session) {
	out := map[string]any{}
	app.store.Read(func(c *Config) {
		out["entrance"] = c.Entrance
		out["listen"] = c.Listen
		out["tls_cert"] = c.TLSCert
		out["tls_key"] = c.TLSKey
		out["http_port"] = c.HTTPPort
		out["ip_allowlist"] = c.IPAllowlist
		out["known_services"] = c.KnownServices
		out["session_hours"] = c.SessionHours
	})
	apiOK(w, out)
}

// handleSettingsSave updates security settings: entrance path, listen address, TLS, IP allowlist, known services
func (app *App) handleSettingsSave(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		Entrance      *string         `json:"entrance"`
		Listen        *string         `json:"listen"`
		TLSCert       *string         `json:"tls_cert"`
		TLSKey        *string         `json:"tls_key"`
		HTTPPort      *string         `json:"http_port"`
		IPAllowlist   *[]string       `json:"ip_allowlist"`
		KnownServices *[]KnownService `json:"known_services"`
		SessionHours  *int            `json:"session_hours"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	err := app.store.Update(func(c *Config) {
		if req.Entrance != nil {
			c.Entrance = strings.TrimSpace(*req.Entrance)
		}
		if req.Listen != nil {
			c.Listen = strings.TrimSpace(*req.Listen)
		}
		if req.TLSCert != nil {
			c.TLSCert = strings.TrimSpace(*req.TLSCert)
		}
		if req.TLSKey != nil {
			c.TLSKey = strings.TrimSpace(*req.TLSKey)
		}
		if req.HTTPPort != nil {
			c.HTTPPort = strings.TrimSpace(*req.HTTPPort)
		}
		if req.IPAllowlist != nil {
			c.IPAllowlist = *req.IPAllowlist
		}
		if req.KnownServices != nil {
			c.KnownServices = *req.KnownServices
		}
		if req.SessionHours != nil && *req.SessionHours >= 1 && *req.SessionHours <= 720 {
			c.SessionHours = *req.SessionHours
		}
	})
	if err != nil {
		apiErr(w, 500, err.Error())
		return
	}
	app.audit("settings_save", "")
	apiOK(w, map[string]any{"note": "listen/TLS changes take effect after the panel is restarted"})
}

// handlePasswordChange changes the caller's own password
func (app *App) handlePasswordChange(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	if len(req.New) < 10 {
		apiErr(w, 400, "New password must be at least 10 characters")
		return
	}
	ok := false
	app.store.Read(func(c *Config) {
		for _, u := range c.Users {
			if u.Name == s.User && verifyPassword(req.Old, u.Hash) {
				ok = true
			}
		}
	})
	if !ok {
		apiErr(w, 401, "Incorrect old password")
		return
	}
	err := app.store.Update(func(c *Config) {
		for i := range c.Users {
			if c.Users[i].Name == s.User {
				c.Users[i].Hash = hashPassword(req.New)
			}
		}
	})
	if err != nil {
		apiErr(w, 500, err.Error())
		return
	}
	app.audit("password_change", s.User)
	apiOK(w, nil)
}
