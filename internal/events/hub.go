// Package events implements cursor-aware WebSocket delivery.
package events

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/FireStarsSoft/Bored-Manager/internal/store"
	"github.com/gorilla/websocket"
)

type subscriber struct {
	events chan store.Event
	resync chan struct{}
}

// Hub fans durable events out to bounded client buffers.
type Hub struct {
	store       *store.Store
	buffer      int
	mu          sync.Mutex
	subscribers map[*subscriber]struct{}
}

func New(database *store.Store, buffer int) *Hub {
	if buffer < 16 {
		buffer = 16
	}
	return &Hub{store: database, buffer: buffer, subscribers: make(map[*subscriber]struct{})}
}

// Publish persists the event before exposing its cursor to live clients.
func (h *Hub) Publish(ctx context.Context, eventType string, payload any) (store.Event, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return store.Event{}, err
	}
	event, err := h.store.AppendEvent(ctx, eventType, raw)
	if err != nil {
		return store.Event{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for client := range h.subscribers {
		select {
		case client.events <- event:
		default:
			select {
			case client.resync <- struct{}{}:
			default:
			}
		}
	}
	return event, nil
}

func (h *Hub) subscribe() *subscriber {
	client := &subscriber{events: make(chan store.Event, h.buffer), resync: make(chan struct{}, 1)}
	h.mu.Lock()
	h.subscribers[client] = struct{}{}
	h.mu.Unlock()
	return client
}

func (h *Hub) unsubscribe(client *subscriber) {
	h.mu.Lock()
	delete(h.subscribers, client)
	h.mu.Unlock()
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     originAllowed,
}

func originAllowed(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.User != nil || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	expectedScheme := "https"
	if request.TLS == nil {
		expectedScheme = "http"
	}
	return parsed.Scheme == expectedScheme && strings.EqualFold(parsed.Host, request.Host)
}

// ServeWebSocket replays durable events after cursor, then switches to live
// delivery. A retention gap or slow-client overflow explicitly requests resync.
func (h *Hub) ServeWebSocket(response http.ResponseWriter, request *http.Request) {
	cursor, _ := strconv.ParseInt(request.URL.Query().Get("cursor"), 10, 64)
	connection, err := upgrader.Upgrade(response, request, nil)
	if err != nil {
		return
	}
	defer connection.Close()
	client := h.subscribe()
	defer h.unsubscribe(client)

	history, minimum, err := h.store.EventsSince(request.Context(), cursor, h.buffer+1)
	if err != nil {
		latest, _ := h.store.LatestEventCursor(request.Context())
		writeResyncRequired(connection, "sequence_gap", latest)
		return
	}
	if cursor > 0 && minimum > 0 && cursor < minimum-1 {
		latest, _ := h.store.LatestEventCursor(request.Context())
		writeResyncRequired(connection, "cursor_expired", latest)
		return
	}
	if len(history) > h.buffer {
		latest, _ := h.store.LatestEventCursor(request.Context())
		writeResyncRequired(connection, "sequence_gap", latest)
		return
	}
	latest := cursor
	for _, event := range history {
		if err := connection.WriteJSON(event); err != nil {
			return
		}
		latest = event.Cursor
	}

	_ = connection.SetReadDeadline(time.Now().Add(90 * time.Second))
	connection.SetPongHandler(func(string) error { return connection.SetReadDeadline(time.Now().Add(90 * time.Second)) })
	disconnected := make(chan struct{})
	go func() {
		defer close(disconnected)
		for {
			if _, _, err := connection.ReadMessage(); err != nil {
				return
			}
		}
	}()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-disconnected:
			return
		case <-client.resync:
			current, _ := h.store.LatestEventCursor(request.Context())
			writeResyncRequired(connection, "buffer_overrun", current)
			return
		case event := <-client.events:
			if event.Cursor <= latest {
				continue
			}
			if err := connection.WriteJSON(event); err != nil {
				return
			}
			latest = event.Cursor
		case <-ticker.C:
			if err := connection.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
				return
			}
		}
	}
}

func writeResyncRequired(connection *websocket.Conn, reason string, latest int64) {
	_ = connection.WriteJSON(map[string]any{
		"cursor":      strconv.FormatInt(latest, 10),
		"type":        "resync_required",
		"occurred_at": time.Now().UTC(),
		"payload": map[string]any{
			"reason":        reason,
			"latest_cursor": strconv.FormatInt(latest, 10),
		},
	})
}
