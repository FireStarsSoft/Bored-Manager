package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/FireStarsSoft/Bored-Manager/internal/updatehelper"
)

func main() {
	server, err := updatehelper.Default()
	if err != nil {
		slog.Error("initialize update helper", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := server.Run(ctx); err != nil {
		slog.Error("update helper stopped", "error", err)
		os.Exit(1)
	}
}
