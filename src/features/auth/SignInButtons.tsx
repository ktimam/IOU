// The Internet Identity + (dev-only) local-identity sign-in buttons, shared by every INLINE
// sign-in surface: the /sign-in page and the OpenChat connect surface
// (/settings#openchat-connect). Rendering sign-in inline — rather than redirecting to /sign-in or
// / — keeps the current URL, hash and query intact (e.g. /settings#openchat-connect), so an
// unsigned visitor lands exactly where they were headed once authenticated instead of on the
// landing page.

import { useAuth } from "./AuthProvider";

export function SignInButtons() {
  const { signIn, signInDev } = useAuth();
  return (
    <>
      <div className="cta-row" style={{ justifyContent: "center" }}>
        <button
          onClick={async () => {
            try {
              await signIn();
            } catch (e) {
              console.error(e);
            }
          }}
        >
          Sign in with Internet Identity
        </button>
      </div>
      {import.meta.env.DEV && (
        <div className="cta-row" style={{ justifyContent: "center", marginTop: 12 }}>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await signInDev();
              } catch (e) {
                console.error(e);
              }
            }}
          >
            Sign in (dev — local identity)
          </button>
        </div>
      )}
    </>
  );
}
