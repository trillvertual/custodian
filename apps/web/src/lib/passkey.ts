import {
  startRegistration,
  startAuthentication,
  WebAuthnAbortService,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/browser";
import {
  ready,
  decode,
  encode,
  wrapPasskey,
  erase,
  type Encrypted,
} from "../../../../packages/core/src/index.ts";
import { api, setCsrf } from "./api.ts";
// Stable cryptographic context: keep this value across product renames.
const prfSalt = new TextEncoder().encode("Shared Vault identity wrapping v1");
type Output = {
  prf?: {
    enabled?: boolean;
    results?: { first: Uint8Array | string | ArrayBuffer };
  };
};
function prfBytes(
  response: RegistrationResponseJSON | AuthenticationResponseJSON,
): Uint8Array | null {
  const value = (response.clientExtensionResults as Output).prf?.results?.first;
  return value
    ? typeof value === "string"
      ? decode(value)
      : new Uint8Array(value)
    : null;
}
function strip<T extends RegistrationResponseJSON | AuthenticationResponseJSON>(
  response: T,
): T {
  const { prf: _prf, ...rest } = response.clientExtensionResults as Output;
  return { ...response, clientExtensionResults: rest };
}
export type PasskeyEnrollmentOperation = {
  assertActive: () => void;
  getPrivateKey: () => Uint8Array;
};
function enrollmentWrap(
  operation: PasskeyEnrollmentOperation,
  prf: Uint8Array,
  userId: string,
  id: string,
): Encrypted {
  operation.assertActive();
  // Read the live key only after the ceremony. This copy never spans an await.
  const privateKey = operation.getPrivateKey().slice();
  try {
    operation.assertActive();
    return wrapPasskey(privateKey, prf, userId, id);
  } finally {
    erase(privateKey);
  }
}
export function cancelPasskeyCeremony() {
  WebAuthnAbortService.cancelCeremony();
}
export async function registerPasskey(
  operation: PasskeyEnrollmentOperation,
  userId: string,
) {
  let prf: Uint8Array | null = null;
  try {
    await ready;
    operation.assertActive();
    const { options, flow } = await api<{
      options: PublicKeyCredentialCreationOptionsJSON;
      flow: string;
    }>("/auth/passkey/register/options", "POST");
    operation.assertActive();
    options.extensions = {
      ...options.extensions,
      prf: { eval: { first: prfSalt } },
    };
    const response = await startRegistration({ optionsJSON: options });
    prf = prfBytes(response);
    operation.assertActive();
    let wrapped = !!prf;
    await api("/auth/passkey/register/verify", "POST", {
      flow,
      response: strip(response),
      ...(prf
        ? { wrap: enrollmentWrap(operation, prf, userId, response.id) }
        : {}),
    });
    operation.assertActive();
    if (!prf) {
      try {
        const authenticated = await authenticatePasskey(
          response.id,
          operation.assertActive,
        );
        prf = authenticated.prf;
        operation.assertActive();
        if (prf) {
          await enablePrfWrap(operation, userId, response.id, prf);
          operation.assertActive();
          wrapped = true;
        }
      } catch {
        // Cancellation must not become an apparently successful enrollment.
        operation.assertActive();
        /* The key remains usable for login; password stays enabled. */
      }
    }
    return { prf: wrapped, id: response.id };
  } finally {
    erase(prf);
  }
}
export async function authenticatePasskey(
  credentialId?: string,
  assertActive: () => void = () => {},
): Promise<{
  id: string;
  prf: Uint8Array | null;
}> {
  let prf: Uint8Array | null = null;
  try {
    await ready;
    assertActive();
    const { options, flow } = await api<{
      options: PublicKeyCredentialRequestOptionsJSON;
      flow: string;
    }>("/auth/passkey/options", "POST");
    assertActive();
    options.extensions = {
      ...options.extensions,
      prf: { eval: { first: prfSalt } },
    };
    if (credentialId)
      options.allowCredentials = [{ id: credentialId, type: "public-key" }];
    const response = await startAuthentication({ optionsJSON: options });
    prf = prfBytes(response);
    assertActive();
    const session = await api<{ csrf: string }>(
      "/auth/passkey/verify",
      "POST",
      {
        flow,
        response: strip(response),
      },
    );
    assertActive();
    setCsrf(session.csrf);
    return { id: response.id, prf };
  } catch (e) {
    erase(prf);
    throw e;
  }
}
export async function enablePrfWrap(
  operation: PasskeyEnrollmentOperation,
  userId: string,
  id: string,
  prf: Uint8Array,
) {
  const wrap = enrollmentWrap(operation, prf, userId, id);
  await api("/auth/passkey/wrap", "POST", { id, wrap });
  operation.assertActive();
}
