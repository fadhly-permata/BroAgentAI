package main

import (
  "encoding/json"
  "fmt"
  "os"
  "path/filepath"
  "strings"
)

// Workspace allowlist: hanya path di dalam salah satu workspace yang boleh diakses.
// Disimpan di %APPDATA%/BroAgentAI/workspaces.json â€” diedit lewat tray / Settings.
func loadWorkspaces() []string {
  b, err := os.ReadFile(filepath.Join(appDir(), "workspaces.json"))
  if err != nil { return nil }
  var ws []string
  json.Unmarshal(b, &ws)
  return ws
}
func isAllowed(path string) bool {
  abs, err := filepath.Abs(path)
  if err != nil { return false }
  for _, w := range loadWorkspaces() {
    wa, _ := filepath.Abs(w)
    if abs == wa || strings.HasPrefix(abs, wa+string(os.PathSeparator)) { return true }
  }
  return false
}
func fsList(path string) (any, error) {
  if !isAllowed(path) { return nil, fmt.Errorf("path not in workspace allowlist") }
  entries, err := os.ReadDir(path)
  if err != nil { return nil, err }
  type E struct { Name string `json:"name"`; IsDir bool `json:"isDir"`; Size int64 `json:"size"` }
  out := []E{}
  for _, e := range entries {
    info, _ := e.Info()
    out = append(out, E{e.Name(), e.IsDir(), info.Size()})
  }
  return out, nil
}
func fsRead(path string) (any, error) {
  if !isAllowed(path) { return nil, fmt.Errorf("path not in workspace allowlist") }
  b, err := os.ReadFile(path)
  if err != nil { return nil, err }
  return map[string]any{"path": path, "content": string(b)}, nil
}
func fsWrite(path, content string) (any, error) {
  if !isAllowed(path) { return nil, fmt.Errorf("path not in workspace allowlist") }
  if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil { return nil, err }
  if err := os.WriteFile(path, []byte(content), 0644); err != nil { return nil, err }
  broadcast(Event{Event: "fs.changed", Payload: map[string]any{"path": path}})
  return map[string]any{"path": path, "ok": true}, nil
}
