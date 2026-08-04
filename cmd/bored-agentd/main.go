package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/FireStarsSoft/Bored-Manager/internal/agent"
	"github.com/FireStarsSoft/Bored-Manager/internal/config"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)
	cfg, err := config.LoadAgent()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	daemon, err := agent.New(cfg, logger)
	if err != nil {
		logger.Error("initialize agent", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := daemon.Run(ctx); err != nil {
		logger.Error("agent stopped", "error", err)
		os.Exit(1)
	}
}
