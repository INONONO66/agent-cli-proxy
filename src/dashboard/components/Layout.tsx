import React, { useCallback, useContext, useEffect, useState } from "react";
import { getSession, logout } from "../api";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Gauge,
  FileText,
  BarChart3,
  KeyRound,
  ShieldCheck,
  LogOut,
} from "lucide-react";

interface AuthContextValue {
  authenticated: boolean;
  setAuthenticated: (value: boolean) => void;
  loading: boolean;
  loginConfigured: boolean;
}

export const AuthContext = React.createContext<AuthContextValue>({
  authenticated: false,
  setAuthenticated: () => {},
  loading: true,
  loginConfigured: true,
});

const NAV = [
  { path: "#/quotas", label: "Quotas", icon: Gauge },
  { path: "#/logs", label: "Logs", icon: FileText },
  { path: "#/usage", label: "Usage", icon: BarChart3 },
  { path: "#/api-keys", label: "API Keys", icon: KeyRound },
  { path: "#/oauth", label: "OAuth", icon: ShieldCheck },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { setAuthenticated } = useContext(AuthContext);
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    function onHashChange() {
      setHash(window.location.hash);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    setAuthenticated(false);
    window.location.hash = "#/login";
  }, [setAuthenticated]);

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="px-4 py-4">
          <h1 className="text-lg font-semibold">agent-cli-proxy</h1>
          <div className="text-xs text-muted-foreground">dashboard</div>
        </SidebarHeader>
        <Separator />
        <SidebarContent className="px-2 py-2">
          <SidebarMenu>
            {NAV.map((item) => (
              <SidebarMenuItem key={item.path}>
                <SidebarMenuButton
                  asChild
                  isActive={hash === item.path || hash.startsWith(item.path + "/")}
                  tooltip={item.label}
                >
                  <a href={item.path}>
                    <item.icon />
                    <span>{item.label}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarContent>
        <SidebarFooter className="px-2 py-2">
          <Button variant="outline" className="w-full gap-2" onClick={handleLogout}>
            <LogOut className="size-4" />
            Logout
          </Button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <span className="text-sm font-medium">agent-cli-proxy</span>
        </header>
        <ScrollArea className="flex-1 h-[calc(100vh-3rem)] md:h-screen">
          <main className="p-6 min-w-0">{children}</main>
        </ScrollArea>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [loginConfigured, setLoginConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSession()
      .then((res) => {
        setAuthenticated(res.authenticated);
        setLoginConfigured(res.loginConfigured !== false);
      })
      .catch(() => setAuthenticated(false))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onExpired = () => setAuthenticated(false);
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, []);

  return (
    <AuthContext.Provider value={{ authenticated, setAuthenticated, loading, loginConfigured }}>
      {children}
    </AuthContext.Provider>
  );
}
