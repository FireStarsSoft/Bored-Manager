package auth

import "testing"

func TestPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("a-correct-horse-battery-staple")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(hash, "a-correct-horse-battery-staple") {
		t.Fatal("valid password rejected")
	}
	if VerifyPassword(hash, "definitely-wrong") {
		t.Fatal("invalid password accepted")
	}
}

func TestShortPasswordRejected(t *testing.T) {
	if _, err := HashPassword("too-short"); err == nil {
		t.Fatal("short password accepted")
	}
}
