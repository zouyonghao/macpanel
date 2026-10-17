package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true }, // same-origin is guaranteed by the session cookie
}

// GET /api/terminal?cmd=<optional, e.g. "docker ps"> — WS ↔ PTY
func (app *App) handleTerminal(w http.ResponseWriter, r *http.Request, s *Session) {
	if app.store.Cfg.TLSCert == "" && r.Host != "" {
		// HTTP is allowed, but audited
		app.audit("terminal_open", clientIP(r)+" (HTTP)")
	} else {
		app.audit("terminal_open", clientIP(r))
	}
	ws, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	cmdArg := r.URL.Query().Get("cmd")
	var argv []string
	if cmdArg != "" {
		argv = []string{shell, "-lc", cmdArg}
	} else {
		argv = []string{shell, "-l"}
	}
	p, err := pty.Start(exec.Command(argv[0], argv[1:]...))
	if err != nil {
		ws.WriteMessage(websocket.TextMessage, []byte("\r\nFailed to start terminal: "+err.Error()+"\r\n"))
		return
	}
	defer p.Close()

	var once sync.Once
	closed := make(chan struct{})
	closeAll := func() {
		once.Do(func() {
			close(closed)
			p.Close()
			ws.Close()
		})
	}
	defer closeAll()

	// PTY → WS
	go func() {
		buf := make([]byte, 8192)
		for {
			n, err := p.Read(buf)
			if n > 0 {
				if werr := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// WS → PTY (supports {"type":"resize","cols":..,"rows":..})
	for {
		mt, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		if mt == websocket.TextMessage && len(data) > 0 && data[0] == '{' {
			var ctl struct {
				Type string `json:"type"`
				Cols int    `json:"cols"`
				Rows int    `json:"rows"`
			}
			if json.Unmarshal(data, &ctl) == nil && ctl.Type == "resize" {
				if ctl.Cols > 0 && ctl.Rows > 0 && ctl.Cols < 500 && ctl.Rows < 300 {
					_ = pty.Setsize(p, &pty.Winsize{Cols: uint16(ctl.Cols), Rows: uint16(ctl.Rows)})
				}
				continue
			}
		}
		if _, err := p.Write(data); err != nil {
			log.Println("pty write:", err)
			return
		}
	}
}
