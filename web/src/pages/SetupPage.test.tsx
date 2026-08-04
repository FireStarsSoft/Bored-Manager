import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiContext } from "../api/context";
import { MockApiClient } from "../api/mock";
import { SetupPage } from "./SetupPage";

describe("first-run setup", () => {
  test("blocks unavailable Docker and explains the required listener restart", async () => {
    const user = userEvent.setup();
    const api = new MockApiClient();
    const onComplete = vi.fn();
    render(
      <ApiContext.Provider value={api}>
        <SetupPage
          status={{
            configured: false,
            version: "0.1.0-alpha.1",
            serverFingerprint: "SHA256:TEST-FINGERPRINT",
            localDocker: "unavailable",
            bindAddress: "127.0.0.1",
            webPort: 8443,
            agentPort: 9443,
          }}
          onComplete={onComplete}
        />
      </ApiContext.Provider>,
    );

    await user.type(screen.getByLabelText("Display name"), "Test Administrator");
    await user.clear(screen.getByLabelText("Username"));
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "Strong-password-123");
    await user.type(screen.getByLabelText("Confirm password"), "Strong-password-123");
    await user.click(screen.getByRole("button", { name: /Continue/ }));

    await user.selectOptions(screen.getByLabelText("Bind address"), "0.0.0.0");
    await user.click(screen.getByRole("button", { name: /Continue/ }));

    expect(screen.getByRole("button", { name: /Register accessible local engine/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    await user.click(screen.getByRole("button", { name: /Create manager/ }));

    expect(await screen.findByRole("heading", { name: "Restart, verify, then sign in again" })).toBeInTheDocument();
    expect(screen.getByText(/sudo systemctl restart bored-managerd.service/)).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
