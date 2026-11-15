package main

import (
  "fmt"
  "github.com/go-git/go-git/v5"
  "github.com/go-git/go-git/v5/plumbing/object"
)

// Git asli via go-git (library di dalam bridge). TIDAK memanggil git.exe sistem.
// Repo .git yang dihasilkan bisa dibuka di Git CLI manapun.
func openRepo(cwd string) (*git.Repository, error) {
  if !isAllowed(cwd) { return nil, fmt.Errorf("path not in workspace allowlist") }
  return git.PlainOpen(cwd)
}
func gitStatus(cwd string) (any, error) {
  r, err := openRepo(cwd); if err != nil { return nil, err }
  w, err := r.Worktree(); if err != nil { return nil, err }
  st, err := w.Status(); if err != nil { return nil, err }
  type F struct { File string `json:"file"`; Status string `json:"status"` }
  out := []F{}
  for f, s := range st { out = append(out, F{f, string(s.Staging) + string(s.Worktree)}) }
  h, _ := r.Head()
  branch := ""
  if h != nil { branch = h.Name().Short() }
  return map[string]any{"branch": branch, "files": out}, nil
}
func gitLog(cwd string, limit int) (any, error) {
  r, err := openRepo(cwd); if err != nil { return nil, err }
  h, err := r.Head(); if err != nil { return nil, err }
  iter, err := r.Log(&git.LogOptions{From: h.Hash()}); if err != nil { return nil, err }
  type C struct { Hash string `json:"hash"`; Message string `json:"message"`; Author string `json:"author"`; When string `json:"when"` }
  out := []C{}
  _ = iter.ForEach(func(c *object.Commit) error {
    if len(out) >= limit { return fmt.Errorf("stop") }
    out = append(out, C{c.Hash.String()[:7], c.Message, c.Author.Name, c.Author.When.String()})
    return nil
  })
  return out, nil
}
func gitDiff(cwd, file string) (any, error) {
  // v1: kembalikan status saja; diff detail menyusul di M3 (butuh patch generation).
  return gitStatus(cwd)
}
func gitStage(cwd string, files []string) (any, error) {
  r, err := openRepo(cwd); if err != nil { return nil, err }
  w, err := r.Worktree(); if err != nil { return nil, err }
  if len(files) == 0 { if err := w.AddGlob("."); err != nil { return nil, err } } else {
    for _, f := range files { if _, err := w.Add(f); err != nil { return nil, err } }
  }
  return map[string]any{"ok": true}, nil
}
func gitCommit(cwd, message string) (any, error) {
  r, err := openRepo(cwd); if err != nil { return nil, err }
  w, err := r.Worktree(); if err != nil { return nil, err }
  if message == "" { return nil, fmt.Errorf("commit message kosong") }
  h, err := w.Commit(message, &git.CommitOptions{Author: &object.Signature{Name: "BroAgentAI", Email: "broagentai@local"}})
  if err != nil { return nil, err }
  broadcast(Event{Event: "git.changed", Payload: map[string]any{"cwd": cwd}})
  return map[string]any{"hash": h.String()}, nil
}
