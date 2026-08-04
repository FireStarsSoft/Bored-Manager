package domain

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// EventCursor is an opaque, monotonically increasing event-log position. JSON
// uses a string to avoid JavaScript integer precision loss.
type EventCursor uint64

func (c EventCursor) String() string { return strconv.FormatUint(uint64(c), 10) }

func (c EventCursor) MarshalJSON() ([]byte, error) { return json.Marshal(c.String()) }

func (c *EventCursor) UnmarshalJSON(data []byte) error {
	var encoded string
	if err := json.Unmarshal(data, &encoded); err != nil {
		return fmt.Errorf("event cursor must be a decimal string: %w", err)
	}
	value, err := strconv.ParseUint(encoded, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid event cursor: %w", err)
	}
	*c = EventCursor(value)
	return nil
}

type EventType string

const (
	EventAgentChanged      EventType = "agent.changed"
	EventEnrollmentChanged EventType = "enrollment.changed"
	EventServiceChanged    EventType = "service.changed"
	EventJobChanged        EventType = "job.changed"
	EventDockerHostChanged EventType = "docker_host.changed"
	EventAlertChanged      EventType = "alert.changed"
	EventReleaseChanged    EventType = "release.changed"
	EventResyncRequired    EventType = "resync_required"
)

func (t EventType) Validate() error {
	switch t {
	case EventAgentChanged, EventEnrollmentChanged, EventServiceChanged, EventJobChanged,
		EventDockerHostChanged, EventAlertChanged, EventReleaseChanged, EventResyncRequired:
		return nil
	default:
		return fmt.Errorf("unknown event type %q", t)
	}
}

// EventEnvelope is emitted on /api/v1/events. Payload schemas are selected by
// Type; resync_required contains a ResyncRequired payload.
type EventEnvelope struct {
	Cursor       EventCursor     `json:"cursor"`
	Type         EventType       `json:"type"`
	ResourceType string          `json:"resource_type,omitempty"`
	ResourceID   string          `json:"resource_id,omitempty"`
	OccurredAt   time.Time       `json:"occurred_at"`
	Payload      json.RawMessage `json:"payload,omitempty"`
}

func (e EventEnvelope) Validate() error {
	validation := new(ValidationError)
	if e.Cursor == 0 {
		validation.add("cursor", "must be greater than zero")
	}
	if err := e.Type.Validate(); err != nil {
		validation.add("type", err.Error())
	}
	if err := validateTimestamp(e.OccurredAt); err != nil {
		validation.add("occurred_at", err.Error())
	}
	if e.Type == EventResyncRequired {
		if e.ResourceType != "" || e.ResourceID != "" {
			validation.add("resource_id", "resync_required must not identify a single resource")
		}
		var payload ResyncRequired
		if err := json.Unmarshal(e.Payload, &payload); err != nil || payload.LatestCursor == 0 {
			validation.add("payload", "must contain a valid resync_required payload")
		}
	} else {
		if err := validateRequired(e.ResourceType); err != nil {
			validation.add("resource_type", err.Error())
		}
		if err := validateRequired(e.ResourceID); err != nil {
			validation.add("resource_id", err.Error())
		}
	}
	return validation.errOrNil()
}

type ResyncReason string

const (
	ResyncCursorExpired ResyncReason = "cursor_expired"
	ResyncBufferOverrun ResyncReason = "buffer_overrun"
	ResyncSequenceGap   ResyncReason = "sequence_gap"
)

type ResyncRequired struct {
	Reason       ResyncReason `json:"reason"`
	LatestCursor EventCursor  `json:"latest_cursor"`
}

// CursorPage is embedded into list responses to establish the snapshot/event
// handoff point and support deterministic pagination.
type CursorPage struct {
	NextPageToken string      `json:"next_page_token,omitempty"`
	EventCursor   EventCursor `json:"event_cursor"`
}

// Problem follows RFC 9457-compatible problem detail semantics while keeping
// stable machine-readable codes and per-field validation errors.
type Problem struct {
	Type       string           `json:"type"`
	Title      string           `json:"title"`
	Status     int              `json:"status"`
	Detail     string           `json:"detail,omitempty"`
	Instance   string           `json:"instance,omitempty"`
	Code       string           `json:"code"`
	RequestID  string           `json:"request_id,omitempty"`
	Violations []FieldViolation `json:"violations,omitempty"`
}
