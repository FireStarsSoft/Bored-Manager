package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/FireStarsSoft/Bored-Manager/internal/config"
	"github.com/FireStarsSoft/Bored-Manager/internal/manager"
	"github.com/FireStarsSoft/Bored-Manager/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	cfg, err := config.LoadManager()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	if err := cfg.EnsureDirectories(); err != nil {
		logger.Error("create runtime directories", "error", err)
		os.Exit(1)
	}
	database, err := store.Open(cfg.DatabasePath)
	if err != nil {
		logger.Error("open manager database", "error", err)
		os.Exit(1)
	}
	defer database.Close()
	// First-run network choices take effect after restart unless an explicit
	// environment override is present.
	if _, ok := os.LookupEnv("BORED_MANAGER_BIND"); !ok {
		if value, found, _ := database.Setting(context.Background(), "bind_address"); found {
			cfg.BindAddress = value
		}
	}
	if _, ok := os.LookupEnv("BORED_MANAGER_WEB_PORT"); !ok {
		if value, found, _ := database.Setting(context.Background(), "web_port"); found {
			if parsed, e := strconv.Atoi(value); e == nil {
				cfg.WebPort = parsed
			}
		}
	}
	if _, ok := os.LookupEnv("BORED_MANAGER_AGENT_PORT"); !ok {
		if value, found, _ := database.Setting(context.Background(), "agent_port"); found {
			if parsed, e := strconv.Atoi(value); e == nil {
				cfg.AgentPort = parsed
			}
		}
	}
	server, err := manager.New(cfg, database, logger)
	if err != nil {
		logger.Error("initialize manager", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := server.Run(ctx); err != nil {
		logger.Error("manager stopped", "error", err)
		os.Exit(1)
	}
}
