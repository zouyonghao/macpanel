package main

import (
	"net/http"
	"strings"
)

// GET /api/termcmds
func (app *App) handleTermCmdList(w http.ResponseWriter, r *http.Request, s *Session) {
	var cmds []TermCmd
	app.store.Read(func(c *Config) {
		cmds = append([]TermCmd(nil), c.TermCmds...)
	})
	apiOK(w, map[string]any{"commands": cmds})
}

// POST /api/termcmds/save {id, name, cmd} — empty id adds, an existing id updates
func (app *App) handleTermCmdSave(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Cmd  string `json:"cmd"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Cmd = strings.TrimSpace(req.Cmd)
	if req.Name == "" || req.Cmd == "" {
		apiErr(w, 400, "Name and command are required")
		return
	}
	if runeLen(req.Name) > 64 || runeLen(req.Cmd) > 500 {
		apiErr(w, 400, "Field too long")
		return
	}
	if req.ID == "" {
		req.ID = randomToken(8)
	}
	c := TermCmd{ID: req.ID, Name: req.Name, Cmd: req.Cmd}
	updated := false
	_ = app.store.Update(func(cfg *Config) {
		for i := range cfg.TermCmds {
			if cfg.TermCmds[i].ID == req.ID {
				cfg.TermCmds[i] = c
				updated = true
				return
			}
		}
		cfg.TermCmds = append(cfg.TermCmds, c)
	})
	app.audit("termcmd_save", c.Name)
	apiOK(w, map[string]any{"command": c, "updated": updated})
}

// POST /api/termcmds/delete {id}
func (app *App) handleTermCmdDelete(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	_ = app.store.Update(func(c *Config) {
		out := c.TermCmds[:0]
		for _, cmd := range c.TermCmds {
			if cmd.ID != req.ID {
				out = append(out, cmd)
			}
		}
		c.TermCmds = out
	})
	app.audit("termcmd_delete", req.ID)
	apiOK(w, nil)
}

// POST /api/termcmds/move {id, dir} — dir is "up" or "down", swaps with the neighbor
func (app *App) handleTermCmdMove(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		ID  string `json:"id"`
		Dir string `json:"dir"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	_ = app.store.Update(func(c *Config) {
		for i := range c.TermCmds {
			if c.TermCmds[i].ID != req.ID {
				continue
			}
			j := i - 1
			if req.Dir == "down" {
				j = i + 1
			}
			if j < 0 || j >= len(c.TermCmds) {
				return
			}
			c.TermCmds[i], c.TermCmds[j] = c.TermCmds[j], c.TermCmds[i]
			return
		}
	})
	apiOK(w, nil)
}
