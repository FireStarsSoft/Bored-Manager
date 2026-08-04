// Package domain contains the stable JSON-domain contracts shared by the
// manager, agents, CLI, and generated API adapters.
package domain

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	uuidV7Pattern      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	slugPattern        = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$`)
	sha256Pattern      = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	codePattern        = regexp.MustCompile(`^[A-Z2-7]{4}-[A-Z2-7]{4}$`)
	fingerprintPattern = regexp.MustCompile(`^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$`)
	sshKeyPattern      = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}$`)
	semverPattern      = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
)

// FieldViolation describes one invalid field without leaking internal errors.
type FieldViolation struct {
	Field       string `json:"field"`
	Description string `json:"description"`
}

// ValidationError aggregates all validation failures for a domain value.
type ValidationError struct {
	Violations []FieldViolation `json:"violations"`
}

func (e *ValidationError) Error() string {
	if e == nil || len(e.Violations) == 0 {
		return "validation failed"
	}
	parts := make([]string, 0, len(e.Violations))
	for _, violation := range e.Violations {
		parts = append(parts, violation.Field+": "+violation.Description)
	}
	return "validation failed: " + strings.Join(parts, "; ")
}

func (e *ValidationError) add(field, description string) {
	e.Violations = append(e.Violations, FieldViolation{Field: field, Description: description})
}

func (e *ValidationError) errOrNil() error {
	if len(e.Violations) == 0 {
		return nil
	}
	sort.SliceStable(e.Violations, func(i, j int) bool {
		return e.Violations[i].Field < e.Violations[j].Field
	})
	return e
}

// IsValidationError reports whether err is a structured ValidationError.
func IsValidationError(err error) bool {
	var target *ValidationError
	return errors.As(err, &target)
}

// ValidateUUIDv7 validates the canonical lowercase representation used for all
// newly generated public resource identifiers.
func ValidateUUIDv7(value string) error {
	if !uuidV7Pattern.MatchString(value) {
		return fmt.Errorf("must be a canonical lowercase UUIDv7")
	}
	return nil
}

// ValidateSlug validates stable, URL-safe keys used by definitions and names.
func ValidateSlug(value string) error {
	if !slugPattern.MatchString(value) {
		return fmt.Errorf("must contain 1-63 lowercase letters, numbers, dots, underscores, or hyphens")
	}
	return nil
}

// ValidateSHA256Digest validates an OCI-style sha256 digest.
func ValidateSHA256Digest(value string) error {
	if !sha256Pattern.MatchString(value) {
		return fmt.Errorf("must be sha256 followed by 64 lowercase hexadecimal characters")
	}
	return nil
}

func validateVerificationCode(value string) error {
	if !codePattern.MatchString(value) {
		return fmt.Errorf("must use XXXX-XXXX with uppercase RFC 4648 base32 characters")
	}
	return nil
}

func validateFingerprint(value string) error {
	if !fingerprintPattern.MatchString(value) {
		return fmt.Errorf("must be an uppercase colon-separated SHA-256 fingerprint")
	}
	return nil
}

func validateSSHHostKeyFingerprint(value string) error {
	if !sshKeyPattern.MatchString(value) {
		return fmt.Errorf("must use an OpenSSH SHA256 host-key fingerprint")
	}
	return nil
}

func validateRequired(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("is required")
	}
	return nil
}

func validateName(value string, max int) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return errors.New("is required")
	}
	if len(trimmed) > max {
		return fmt.Errorf("must be at most %d bytes", max)
	}
	if strings.ContainsAny(trimmed, "\x00\r\n") {
		return errors.New("must not contain control separators")
	}
	return nil
}

func validateTags(tags []string) error {
	if len(tags) > 64 {
		return errors.New("must contain at most 64 tags")
	}
	seen := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		if err := ValidateSlug(tag); err != nil {
			return fmt.Errorf("tag %q: %w", tag, err)
		}
		if _, exists := seen[tag]; exists {
			return fmt.Errorf("tag %q is duplicated", tag)
		}
		seen[tag] = struct{}{}
	}
	return nil
}

func validateTimestamp(value time.Time) error {
	if value.IsZero() {
		return errors.New("is required")
	}
	return nil
}

func validateCIDR(value string) error {
	if _, _, err := net.ParseCIDR(value); err != nil {
		return errors.New("must be a valid CIDR")
	}
	return nil
}

func validateIP(value string) error {
	if net.ParseIP(value) == nil {
		return errors.New("must be a valid IP address")
	}
	return nil
}

func validateHTTPSURL(value string) error {
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return errors.New("must be an absolute HTTPS URL")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return errors.New("must not contain user information or a fragment")
	}
	return nil
}
