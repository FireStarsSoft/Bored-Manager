import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "./router";
import { App } from "./App";
import { MockApiClient } from "./api/mock";

describe("Bored Manager shell", () => {
  test("authenticates and opens the fleet overview", async () => {
    const user = userEvent.setup();
    const api = new MockApiClient();
    render(<MemoryRouter initialEntries={["/overview"]}><App client={api} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Sign in to your manager" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Username"), "morgan");
    await user.type(screen.getByLabelText("Password"), "correct-horse-battery-staple");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("heading", { name: /Good morning/ })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Agent and service health" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
  });

  test("requires fingerprint verification and reauthentication before enrollment approval", async () => {
    const user = userEvent.setup();
    const api = new MockApiClient();
    await api.login("morgan", "demo");
    render(<MemoryRouter initialEntries={["/agents"]}><App client={api} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Install an agent/ }));
    expect(await screen.findByRole("heading", { name: "No runnable package yet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("tab", { name: /Pending approval/ }));
    expect(await screen.findByText("warehouse-scanner")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Verify & approve/ })[0]);
    const approve = screen.getByRole("button", { name: "Approve identity" });
    expect(approve).toBeDisabled();
    await user.type(screen.getByLabelText("Verification code"), "CINDER-47");
    await user.type(screen.getByLabelText("Re-enter your password"), "demo-password");
    expect(approve).toBeEnabled();
    await user.click(approve);
    expect(await screen.findByText(/was approved/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("warehouse-scanner")).not.toBeInTheDocument());
  });
});
