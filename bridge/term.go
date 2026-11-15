package main

import (
  "bufio"
  "fmt"
  "io"
  "os/exec"
  "sync"
)

// Terminal v1: cmd.exe dengan stdin/stdout pipes (streaming).
// M4 akan upgrade ke ConPTY agar mendukung program interaktif penuh (vim, dll).
type TermSession struct { Cmd *exec.Cmd; Stdin io.WriteCloser }
var terms sync.Map

func termCreate(cwd string) (any, error) {
  if cwd != "" && !isAllowed(cwd) { return nil, fmt.Errorf("path not in workspace allowlist") }
  id := fmt.Sprintf("term-%d", lenTerm())
  cmd := exec.Command("cmd.exe")
  if cwd != "" { cmd.Dir = cwd }
  stdin, err := cmd.StdinPipe(); if err != nil { return nil, err }
  stdout, err := cmd.StdoutPipe(); if err != nil { return nil, err }
  stderr, err := cmd.StderrPipe(); if err != nil { return nil, err }
  if err := cmd.Start(); err != nil { return nil, err }
  s := &TermSession{Cmd: cmd, Stdin: stdin}
  terms.Store(id, s)
  go pump(id, stdout)
  go pump(id, stderr)
  go func(){ cmd.Wait(); terms.Delete(id); broadcast(Event{Event: "term.exit", Payload: map[string]any{"sessionId": id}}) }()
  return map[string]any{"sessionId": id}, nil
}
func lenTerm() int { n := 0; terms.Range(func(_, _ any) bool { n++; return true }); return n }
func pump(id string, r io.Reader) {
  br := bufio.NewReader(r)
  buf := make([]byte, 4096)
  for { n, err := br.Read(buf); if n > 0 { broadcast(Event{Event: "term.output", Payload: map[string]any{"sessionId": id, "data": string(buf[:n])}}) }; if err != nil { return } }
}
func termInput(sessionId, data string) (any, error) {
  v, ok := terms.Load(sessionId); if !ok { return nil, fmt.Errorf("session not found") }
  _, err := io.WriteString(v.(*TermSession).Stdin, data)
  return map[string]any{"ok": true}, err
}
func termClose(sessionId string) (any, error) {
  v, ok := terms.Load(sessionId); if !ok { return map[string]any{"ok": true}, nil }
  s := v.(*TermSession)
  s.Stdin.Close()
  s.Cmd.Process.Kill()
  terms.Delete(sessionId)
  return map[string]any{"ok": true}, nil
}
