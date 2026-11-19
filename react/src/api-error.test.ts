import { describe, expect, it } from "vitest";
import { ApiError } from "./api-error";

describe("hasMessage", () => {
  it("is true when the envelope or the caller brought a sentence", () => {
    expect(new ApiError(409, { code: "TEXT_SEND_PENDING", message: "Aguarde." }).hasMessage).toBe(
      true,
    );
    // A refusal the API wrote without a code is still a sentence for a person.
    expect(new ApiError(503, null, { message: "O número está desconectado." }).hasMessage).toBe(
      true,
    );
  });

  it("is false when message is only the client's own fallback", () => {
    // A gateway answered with HTML, so there was no envelope at all.
    const error = new ApiError(502, null);
    expect(error.message).toBe("Request failed (502)");
    expect(error.hasMessage).toBe(false);
    // Auth errors arrive with a code and `message: ""`.
    expect(new ApiError(400, { code: "otp_expired", message: "" }).hasMessage).toBe(false);
  });
});
