// bmctl is the local operator CLI for Bored Manager.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/FireStarsSoft/Bored-Manager/internal/clienttls"
	"github.com/FireStarsSoft/Bored-Manager/internal/version"
)

type options struct {
	socket     string
	managerURL string
	spkiPin    string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "bmctl:", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	flags := flag.NewFlagSet("bmctl", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	opts := options{}
	flags.StringVar(&opts.socket, "socket", envOr("BORED_MANAGER_SOCKET", "/run/bored-manager/manager.sock"), "manager control socket")
	flags.StringVar(&opts.managerURL, "url", envOr("BORED_MANAGER_URL", "https://127.0.0.1:8443"), "manager Web URL")
	flags.StringVar(&opts.spkiPin, "spki-pin", os.Getenv("BORED_MANAGER_SPKI_PIN"), "manager SPKI fingerprint")
	if err := flags.Parse(arguments); err != nil {
		return usageError()
	}
	remaining := flags.Args()
	if len(remaining) == 0 {
		return usageError()
	}
	switch remaining[0] {
	case "version":
		if len(remaining) != 1 {
			return usageError()
		}
		return printVersion()
	case "health":
		if len(remaining) != 1 {
			return usageError()
		}
		return requestAndPrint(opts, "/healthz")
	case "diagnostics":
		if len(remaining) != 1 {
			return usageError()
		}
		return requestAndPrint(opts, "/api/v1/diagnostics")
	case "open-ui":
		if len(remaining) != 1 {
			return usageError()
		}
		return openUI(opts.managerURL)
	case "docker-host":
		return runDockerHost(opts, remaining[1:])
	case "help", "--help", "-h":
		if len(remaining) != 1 {
			return usageError()
		}
		fmt.Print(usage())
		return nil
	default:
		return usageError()
	}
}

func usageError() error {
	return errors.New("usage: bmctl [--socket PATH] [--url URL] {version|health|diagnostics|open-ui|docker-host}")
}
func usage() string {
	return "Bored Manager operator CLI\n\nUsage:\n  bmctl version\n  bmctl health\n  bmctl diagnostics\n  bmctl open-ui\n  bmctl docker-host add-local [options]\n\nOptions:\n  --socket PATH       local manager control socket\n  --url URL           Web UI URL\n  --spki-pin SHA256   exact manager SPKI pin for HTTPS fallback\n"
}

func runDockerHost(opts options, arguments []string) error {
	if len(arguments) == 0 || arguments[0] != "add-local" {
		return errors.New("usage: bmctl docker-host add-local --name local --socket /var/run/docker.sock --confirmation TEXT")
	}
	flags := flag.NewFlagSet("docker-host add-local", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	name := "local"
	dockerSocket := "/var/run/docker.sock"
	confirmation := ""
	flags.StringVar(&name, "name", name, "local Docker host name")
	flags.StringVar(&dockerSocket, "socket", dockerSocket, "local Docker Unix socket")
	flags.StringVar(&confirmation, "confirmation", confirmation, "typed root-equivalent confirmation")
	if err := flags.Parse(arguments[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Print("Usage: bmctl docker-host add-local --name local --socket /var/run/docker.sock --confirmation 'I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT'\n")
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || strings.TrimSpace(name) == "" || len(name) > 128 {
		return errors.New("invalid local Docker host name")
	}
	if dockerSocket != "/var/run/docker.sock" {
		return errors.New("v1 supports only the rootful Docker socket /var/run/docker.sock")
	}
	if confirmation != "I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT" {
		return errors.New("typed Docker root-equivalent confirmation did not match")
	}
	body := map[string]string{
		"name":                         name,
		"socket_path":                  dockerSocket,
		"root_equivalent_confirmation": confirmation,
	}
	return requestJSONAndPrint(opts, http.MethodPost, "/api/v1/docker-hosts/local", body)
}

func printVersion() error {
	info := version.Current()
	result := map[string]any{"component": "bmctl", "version": info.Version, "commit": info.Commit, "build_time": info.BuildTime}
	if runtime.GOOS == "linux" {
		command := exec.Command("dpkg-query", "-W", "-f=${Version}", "bored-manager")
		if output, err := command.Output(); err == nil {
			packageVersion := strings.TrimSpace(string(output))
			result["debian_package_version"] = packageVersion
			result["package_matches_binary"] = normalizeDebianVersion(packageVersion) == info.Version
		}
	}
	return pretty(result)
}

func requestAndPrint(opts options, path string) error {
	return requestJSONAndPrint(opts, http.MethodGet, path, nil)
}

func requestJSONAndPrint(opts options, method, path string, requestBody any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, baseURL, err := localClient(opts)
	if err != nil {
		return err
	}
	var payload io.Reader
	if requestBody != nil {
		encoded, marshalErr := json.Marshal(requestBody)
		if marshalErr != nil {
			return marshalErr
		}
		payload = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, baseURL+path, payload)
	if err != nil {
		return err
	}
	if requestBody != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("manager returned %s: %s", response.Status, strings.TrimSpace(string(responseBody)))
	}
	var value any
	if err := json.Unmarshal(responseBody, &value); err != nil {
		return errors.New("manager returned invalid JSON")
	}
	return pretty(value)
}

func localClient(opts options) (*http.Client, string, error) {
	if runtime.GOOS != "windows" {
		transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", opts.socket)
		}}
		return &http.Client{Transport: transport, Timeout: 15 * time.Second}, "http://bored-manager", nil
	}
	if opts.spkiPin == "" {
		return nil, "", errors.New("--spki-pin is required when the Unix control socket is unavailable")
	}
	tlsConfig, err := clienttls.PinnedConfig(opts.spkiPin, (*tls.Certificate)(nil))
	if err != nil {
		return nil, "", err
	}
	return &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig}, Timeout: 15 * time.Second}, strings.TrimRight(opts.managerURL, "/"), nil
}

func pretty(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func openUI(managerURL string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", managerURL)
	case "darwin":
		command = exec.Command("open", managerURL)
	default:
		command = exec.Command("xdg-open", managerURL)
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("open %s: %w", managerURL, err)
	}
	return nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func normalizeDebianVersion(value string) string {
	value = strings.TrimSpace(value)
	if _, after, ok := strings.Cut(value, ":"); ok {
		value = after
	}
	if index := strings.LastIndex(value, "-"); index > 0 {
		value = value[:index]
	}
	return strings.ReplaceAll(value, "~", "-")
}
