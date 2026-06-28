import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Captions, KeyRound } from "lucide-react";
import { useAuthConfig, useLogin, useRegister } from "@/api/auth";
import { APIError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Required"),
  displayName: z.string().optional(),
});
type Form = z.infer<typeof schema>;

const inputCls =
  "h-10 w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/25";

export function Login() {
  const { data: cfg } = useAuthConfig();
  const login = useLogin();
  const register = useRegister();
  const [mode, setMode] = useState<"login" | "register">("login");
  const active = mode === "login" ? login : register;

  const {
    register: field,
    handleSubmit,
    formState: { errors },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  function onSubmit(v: Form) {
    if (mode === "login") login.mutate({ email: v.email, password: v.password });
    else register.mutate({ email: v.email, password: v.password, displayName: v.displayName });
  }

  const err = active.error instanceof APIError ? active.error.message : active.isError ? "Something went wrong" : null;

  return (
    <div className="grid min-h-dvh place-items-center px-5">
      <div className="animate-in w-full max-w-[380px]">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-accent to-amber text-accent-foreground">
            <Captions className="size-5" />
          </span>
          <div>
            <div className="text-lg font-semibold tracking-tight">Sub<span className="text-accent">Extractor</span></div>
            <div className="text-xs text-muted">OCR subtitle extraction & editor</div>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-6">
          <h1 className="text-base font-semibold">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
          <p className="mt-1 text-sm text-muted">
            {mode === "login" ? "Sign in to extract and edit subtitles." : "Set up a local account."}
          </p>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-5 grid gap-3" noValidate>
            {mode === "register" && (
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-muted">Display name</span>
                <input className={inputCls} placeholder="Jane Doe" {...field("displayName")} />
              </label>
            )}
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted">Email</span>
              <input className={inputCls} type="email" autoComplete="email" placeholder="you@example.com" {...field("email")} />
              {errors.email && <span className="text-xs text-err">{errors.email.message}</span>}
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted">Password</span>
              <input className={inputCls} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="••••••••" {...field("password")} />
              {errors.password && <span className="text-xs text-err">{errors.password.message}</span>}
            </label>

            {err && <p role="alert" className="text-sm text-err">{err}</p>}

            <Button variant="primary" type="submit" className="mt-1 h-10" disabled={active.isPending}>
              {active.isPending ? <Spinner className="border-accent-foreground/40 border-t-accent-foreground" /> : mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>

          {cfg?.oidcEnabled && (
            <>
              <div className="my-4 flex items-center gap-3 text-[11px] text-faint">
                <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
              </div>
              <a href="/api/auth/oidc/login">
                <Button variant="default" className="w-full"><KeyRound className="size-4" /> Continue with SSO</Button>
              </a>
            </>
          )}
        </div>

        {cfg?.localRegistrationEnabled !== false && (
          <p className="mt-4 text-center text-sm text-muted">
            {mode === "login" ? "No account? " : "Already have one? "}
            <button onClick={() => setMode(mode === "login" ? "register" : "login")} className="text-accent hover:underline">
              {mode === "login" ? "Create one" : "Sign in"}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
