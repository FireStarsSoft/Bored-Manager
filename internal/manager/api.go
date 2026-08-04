package manager

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/FireStarsSoft/Bored-Manager/internal/auth"
	"github.com/FireStarsSoft/Bored-Manager/internal/store"
)

type contextKey string

const adminContextKey contextKey = "admin"
const sessionContextKey contextKey = "session"

type apiError struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Detail string `json:"detail,omitempty"`
	Code   string `json:"code"`
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(apiError{
		Type:   "/api/v1/problems/" + code,
		Title:  http.StatusText(status),
		Status: status,
		Detail: message,
		Code:   code,
	})
}

func decodeJSON(response http.ResponseWriter, request *http.Request, destination any) error {
	request.Body = http.MaxBytesReader(response, request.Body, 1<<20)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

func remoteIP(request *http.Request) string {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return request.RemoteAddr
	}
	return host
}

func randomID(_ string) (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	milliseconds := uint64(time.Now().UTC().UnixMilli())
	raw[0] = byte(milliseconds >> 40)
	raw[1] = byte(milliseconds >> 32)
	raw[2] = byte(milliseconds >> 24)
	raw[3] = byte(milliseconds >> 16)
	raw[4] = byte(milliseconds >> 8)
	raw[5] = byte(milliseconds)
	raw[6] = (raw[6] & 0x0f) | 0x70
	raw[8] = (raw[8] & 0x3f) | 0x80
	return encodeUUID(raw), nil
}

func encodeUUID(raw []byte) string {
	encoded := make([]byte, 36)
	hex.Encode(encoded[0:8], raw[0:4])
	encoded[8] = '-'
	hex.Encode(encoded[9:13], raw[4:6])
	encoded[13] = '-'
	hex.Encode(encoded[14:18], raw[6:8])
	encoded[18] = '-'
	hex.Encode(encoded[19:23], raw[8:10])
	encoded[23] = '-'
	hex.Encode(encoded[24:36], raw[10:16])
	return string(encoded)
}

func stableUUID(createdAt time.Time, seed string) string {
	digest := sha256.Sum256([]byte(seed))
	raw := append([]byte(nil), digest[:16]...)
	milliseconds := uint64(createdAt.UTC().UnixMilli())
	raw[0] = byte(milliseconds >> 40)
	raw[1] = byte(milliseconds >> 32)
	raw[2] = byte(milliseconds >> 24)
	raw[3] = byte(milliseconds >> 16)
	raw[4] = byte(milliseconds >> 8)
	raw[5] = byte(milliseconds)
	raw[6] = (raw[6] & 0x0f) | 0x70
	raw[8] = (raw[8] & 0x3f) | 0x80
	return encodeUUID(raw)
}

func (s *Server) withAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		cookie, err := request.Cookie("bm_session")
		if err != nil {
			writeError(response, http.StatusUnauthorized, "authentication_required", "authentication required")
			return
		}
		session, err := s.store.Session(request.Context(), auth.DigestToken(cookie.Value))
		if err != nil {
			writeError(response, http.StatusUnauthorized, "invalid_session", "session is invalid")
			return
		}
		now := time.Now().UTC()
		if now.After(session.ExpiresAt) || now.Sub(session.LastSeenAt) > s.config.SessionIdle {
			_ = s.store.DeleteSession(request.Context(), session.TokenHash)
			clearSessionCookies(response, s.config.DevHTTP)
			writeError(response, http.StatusUnauthorized, "session_expired", "session expired")
			return
		}
		if request.Method != http.MethodGet && request.Method != http.MethodHead && request.Method != http.MethodOptions {
			supplied := auth.DigestToken(request.Header.Get("X-CSRF-Token"))
			if request.Header.Get("X-CSRF-Token") == "" || subtle.ConstantTimeCompare([]byte(supplied), []byte(session.CSRFHash)) != 1 {
				writeError(response, http.StatusForbidden, "csrf_failed", "CSRF validation failed")
				return
			}
		}
		if now.Sub(session.LastSeenAt) >= time.Minute {
			_ = s.store.TouchSession(request.Context(), session.TokenHash, now)
		}
		admin := store.Admin{ID: session.AdminID, Username: session.Username}
		ctx := context.WithValue(request.Context(), adminContextKey, admin)
		ctx = context.WithValue(ctx, sessionContextKey, session)
		next(response, request.WithContext(ctx))
	}
}

func currentAdmin(request *http.Request) store.Admin {
	admin, _ := request.Context().Value(adminContextKey).(store.Admin)
	return admin
}
func currentSession(request *http.Request) store.Session {
	session, _ := request.Context().Value(sessionContextKey).(store.Session)
	return session
}

func setSessionCookies(response http.ResponseWriter, sessionToken, csrfToken string, expires time.Time, devHTTP bool) {
	secure := !devHTTP
	http.SetCookie(response, &http.Cookie{Name: "bm_session", Value: sessionToken, Path: "/", Expires: expires, HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode})
	http.SetCookie(response, &http.Cookie{Name: "bm_csrf", Value: csrfToken, Path: "/", Expires: expires, HttpOnly: false, Secure: secure, SameSite: http.SameSiteStrictMode})
}

func clearSessionCookies(response http.ResponseWriter, devHTTP bool) {
	setSessionCookies(response, "", "", time.Unix(1, 0), devHTTP)
}

func (s *Server) newSession(ctx context.Context, admin store.Admin) (string, string, store.Session, error) {
	token, tokenHash, err := auth.NewOpaqueToken()
	if err != nil {
		return "", "", store.Session{}, err
	}
	csrf, csrfHash, err := auth.NewOpaqueToken()
	if err != nil {
		return "", "", store.Session{}, err
	}
	now := time.Now().UTC()
	expires := now.Add(s.config.SessionLifetime)
	session := store.Session{TokenHash: tokenHash, CSRFHash: csrfHash, AdminID: admin.ID, Username: admin.Username, CreatedAt: now, LastSeenAt: now, ExpiresAt: expires}
	err = s.store.CreateSession(ctx, session)
	return token, csrf, session, err
}

func userResponse(admin store.Admin) map[string]any {
	displayName := strings.TrimSpace(admin.DisplayName)
	if displayName == "" {
		displayName = admin.Username
	}
	role := admin.Role
	if role != "admin" && role != "operator" && role != "viewer" {
		role = "admin"
	}
	updatedAt := admin.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = admin.CreatedAt
	}
	return map[string]any{
		"user_id":      stableUUID(admin.CreatedAt, fmt.Sprintf("user:%d:%s", admin.ID, admin.Username)),
		"username":     admin.Username,
		"display_name": displayName,
		"role":         role,
		"created_at":   admin.CreatedAt,
		"updated_at":   updatedAt,
	}
}

func sessionResponse(admin store.Admin, session store.Session, csrf string) map[string]any {
	return map[string]any{
		"session_id":            stableUUID(session.CreatedAt, "session:"+session.TokenHash),
		"user":                  userResponse(admin),
		"csrf_token":            csrf,
		"created_at":            session.CreatedAt,
		"expires_at":            session.ExpiresAt,
		"reauthenticated_until": session.ReauthenticatedUntil,
	}
}

func safeName(value string, max int) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > max {
		return false
	}
	for _, r := range value {
		if !(r == '-' || r == '_' || r == '.' || r == ' ' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}
