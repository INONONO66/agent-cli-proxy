import { useCallback, useContext, useState } from "react";
import { login } from "../api";
import { AuthContext } from "./Layout";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function LoginForm() {
  const { setAuthenticated, loginConfigured } = useContext(AuthContext);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError("");
      setSubmitting(true);
      try {
        const res = await login(password);
        if (res.ok) {
          setAuthenticated(true);
          window.location.hash = "#/quotas";
        } else {
          setError(res.error || "invalid password");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "login failed");
      } finally {
        setSubmitting(false);
      }
    },
    [password, setAuthenticated],
  );

  return (
    <div className="flex items-center justify-center h-screen p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Dashboard Login</CardTitle>
          <CardDescription>
            {loginConfigured ? "Enter your admin password" : "Dashboard password login is not configured"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {!loginConfigured && (
              <p className="text-sm text-muted-foreground">
                Set DASHBOARD_PASSWORD_HASH on the server to enable browser login.
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              disabled={!loginConfigured}
            />
            <Button
              disabled={submitting || !password || !loginConfigured}
              className="w-full"
              type="submit"
            >
              {submitting ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
