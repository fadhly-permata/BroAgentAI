package main

import (
  "encoding/json"
  "flag"
  "fmt"
  "log"
  "net"
  "net/http"
  "os"
  "path/filepath"
  "sync"
  "github.com/gorilla/websocket"
)

type Req struct { ID string `json:"id"`; Token string `json:"token"`; Type string `json:"type"`; Payload json.RawMessage `json:"payload"` }
type Resp struct { ID string `json:"id"`; OK bool `json:"ok"`; Result any `json:"result,omitempty"`; Error string `json:"error,omitempty"` }
type Event struct { Event string `json:"event"`; Payload any `json:"payload"` }

var upgrader = websocket.Upgrader{ CheckOrigin: func(r *http.Request) bool { return true } }
var mu sync.Mutex
var clients = map[*websocket.Conn]bool{}

func appDir() string {
  d, _ := os.UserConfigDir()
  p := filepath.Join(d, "BroAgentAI")
  os.MkdirAll(p, 0755)
  return p
}
func tokenPath() string { return filepath.Join(appDir(), "token.txt") }
func ensureToken() string {
  if b, err := os.ReadFile(tokenPath()); err == nil && len(b) > 0 { return string(b) }
  t := fmt.Sprintf("ba-%d", os.Getpid())
  os.WriteFile(tokenPath(), []byte(t), 0600)
  return t
}
func broadcast(ev Event) {
  mu.Lock(); defer mu.Unlock()
  for c := range clients { c.WriteJSON(ev) }
}
func decode(p json.RawMessage, v any) { json.Unmarshal(p, v) }
func dispatch(req Req) (any, error) {
  var m map[string]any
  decode(req.Payload, &m)
  str := func(k string) string { if s, ok := m[k].(string); ok { return s }; return "" }
  switch req.Type {
  case "ping":
    return map[string]any{"pong": true, "version": "0.1.0"}, nil
  case "fs.list": return fsList(str("path"))
  case "fs.read": return fsRead(str("path"))
  case "fs.write": return fsWrite(str("path"), str("content"))
  case "fs.mkdir":
    if !isAllowed(str("path")) { return nil, fmt.Errorf("path not in workspace allowlist") }
    return map[string]any{"ok": true}, os.MkdirAll(str("path"), 0755)
  case "fs.delete":
    if !isAllowed(str("path")) { return nil, fmt.Errorf("path not in workspace allowlist") }
    return map[string]any{"ok": true}, os.RemoveAll(str("path"))
  case "git.status": return gitStatus(str("cwd"))
  case "git.log": return gitLog(str("cwd"), 20)
  case "git.diff": return gitDiff(str("cwd"), str("file"))
  case "git.stage": return gitStage(str("cwd"), toStrSlice(m["files"]))
  case "git.commit": return gitCommit(str("cwd"), str("message"))
  case "term.create": return termCreate(str("cwd"))
  case "term.input": return termInput(str("sessionId"), str("data"))
  case "term.close": return termClose(str("sessionId"))
  default: return nil, fmt.Errorf("unknown type: %s", req.Type)
  }
}
func toStrSlice(v any) []string {
  out := []string{}
  if arr, ok := v.([]any); ok { for _, x := range arr { if s, ok := x.(string); ok { out = append(out, s) } } }
  return out
}
func handle(w http.ResponseWriter, r *http.Request) {
  host, _, _ := net.SplitHostPort(r.RemoteAddr)
  if host != "127.0.0.1" && host != "::1" { http.Error(w, "forbidden", 403); return }
  c, err := upgrader.Upgrade(w, r, nil)
  if err != nil { return }
  mu.Lock(); clients[c] = true; mu.Unlock()
  defer func(){ mu.Lock(); delete(clients, c); mu.Unlock(); c.Close() }()
  token := ensureToken()
  for {
    var req Req
    if err := c.ReadJSON(&req); err != nil { return }
    if req.Token != token { c.WriteJSON(Resp{ID: req.ID, OK: false, Error: "bad token"}); continue }
    result, err := dispatch(req)
    if err != nil { c.WriteJSON(Resp{ID: req.ID, OK: false, Error: err.Error()}) } else { c.WriteJSON(Resp{ID: req.ID, OK: true, Result: result}) }
  }
}
var portFlag = flag.Int("port", 0, "port to listen on")

func main(){
  flag.Parse()
  ensureToken()
  var ln net.Listener; var port int
  if *portFlag > 0 {
    l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *portFlag))
    if err != nil {
      log.Fatalf("failed to bind requested port %d: %v", *portFlag, err)
    }
    ln = l
    port = *portFlag
  } else {
    for p := 18741; p <= 18760; p++ {
      l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
      if err == nil { ln = l; port = p; break }
    }
    if ln == nil { log.Fatal("no free port") }
  }
  os.WriteFile(filepath.Join(appDir(), "port.txt"), []byte(fmt.Sprint(port)), 0644)
  mux := http.NewServeMux()
  mux.HandleFunc("/ws", handle)
  mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request){ w.Write([]byte("ok")) })
  log.Printf("BroAgentAI Bridge on 127.0.0.1:%d appDir=%s", port, appDir())
  log.Fatal(http.Serve(ln, mux))
}
