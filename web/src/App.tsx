import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ClerkProvider,
  SignIn,
  SignUp,
  useAuth,
  useClerk,
  useUser,
} from "@clerk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  useLocation,
} from "react-router";
import { Theme } from "@astryxdesign/core/theme";
import { AppShell } from "@astryxdesign/core/AppShell";
import {
  MessageCircle,
  Sun,
  CheckSquare,
  Brain,
  Headphones,
  Plug,
  Settings as SettingsIcon,
  Menu,
  X,
  ArrowUpRight,
} from "lucide-react";
import { impoTheme } from "./generated/impo";
import { styles } from "./styles";
import {
  VStack,
  HStack,
  Button,
  Loading,
  ErrorNotice,
  TextInput,
  Page,
} from "./ui";
import { ImpoClient, ApiError } from "./api/client";
import { clearAccountStorage } from "./api/outbox";
import {
  SessionContext,
  useProfile,
  useSession,
  type Session,
} from "./session";
import { AvatarChoice } from "./AvatarChoice";
import { PersonalAgentAvatar } from "./PersonalAgentAvatar";
import { personalAgentName } from "./personal-agent";
import { AccountRecovery, DeletionStatus } from "./AccountRecovery";
const Chat = lazy(() => import("./Chat"));
const Feed = lazy(() => import("./Feed"));
const Tasks = lazy(() => import("./Tasks"));
const Memories = lazy(() =>
  import("./Library").then((m) => ({ default: m.Memories })),
);
const Echo = lazy(() => import("./Library").then((m) => ({ default: m.Echo })));
const Connections = lazy(() => import("./Connections"));
const Settings = lazy(() => import("./Settings"));
const nav = [
  { to: "/", label: "Chat", icon: MessageCircle },
  { to: "/feed", label: "Feed", icon: Sun },
  { to: "/tasks", label: "Tasks", icon: CheckSquare },
  { to: "/memories", label: "Memories", icon: Brain },
  { to: "/echo", label: "Echo", icon: Headphones },
  { to: "/connections", label: "Connections", icon: Plug },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];
class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <VStack padding={8} gap={4}>
        <h1>Something went wrong.</h1>
        <p>Your account data is still safe. Reload to reconnect.</p>
        <Button label="Reload Impo" onClick={() => location.reload()} />
      </VStack>
    ) : (
      this.props.children
    );
  }
}
function Shell() {
  const profile = useProfile();
  const { fixture, api } = useSession();
  const location = useLocation();
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenu(false);
      document.getElementById("mobile-menu-button")?.focus();
    };
    document.addEventListener("keydown", closeMenu);
    return () => document.removeEventListener("keydown", closeMenu);
  }, [menu]);
  useEffect(() => {
    setMenu(false);
    document.title = `${nav.find((n) => (n.to === "/" ? location.pathname === "/" : location.pathname.startsWith(n.to)))?.label || "Impo"} · Impo`;
  }, [location.pathname]);
  useEffect(() => {
    void api.mutate("/today/client", { version: 2 }).catch(() => {});
  }, [api]);
  const links = (
    <>
      {nav.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
        >
          <Icon />
          <b>{label}</b>
        </NavLink>
      ))}
    </>
  );
  return (
    <>
      <AppShell
        height="fill"
        variant="section"
        mobileNav={false}
        contentPadding={0}
        sideNav={
          <VStack
            as="nav"
            aria-label="Main navigation"
            className="sidebar"
            gap={6}
            padding={4}
          >
            <a className="brand" href="/app/">
              <img src="/app/assets/instant-mark.svg" alt="" />
              impo
            </a>
            <VStack gap={1} className="nav-links">
              {links}
            </VStack>
            <VStack className="sidebar-bottom" gap={3}>
              <img src="/app/assets/robin.webp" alt="" />
              <p>
                A little more room
                <br />
                for life.
              </p>
              <a href="/" target="_blank" rel="noreferrer">
                Impo on your phone <ArrowUpRight />
              </a>
            </VStack>
            <NavLink className="account-link" to="/settings">
              <PersonalAgentAvatar profile={profile.data} />
              <VStack gap={1}>
                <b>{profile.data?.displayName || "Your space"}</b>
                <small>{personalAgentName(profile.data)}</small>
              </VStack>
            </NavLink>
          </VStack>
        }
      >
        {fixture && (
          <p className="fixture-banner">
            Local preview · synthetic account data
          </p>
        )}
        <HStack
          className="mobile-header"
          padding={3}
          paddingInline={4}
          hAlign="between"
          vAlign="center"
        >
          <a className="brand" href="/app/">
            <img src="/app/assets/instant-mark.svg" alt="" />
            impo
          </a>
          <Button
            label={menu ? "Close navigation" : "More navigation"}
            id="mobile-menu-button"
            isIconOnly
            icon={menu ? <X /> : <Menu />}
            variant="ghost"
            aria-expanded={menu}
            aria-controls="mobile-navigation-menu"
            onClick={() => setMenu(!menu)}
          />
        </HStack>
        {menu && (
          <VStack
            as="nav"
            aria-label="More navigation"
            id="mobile-navigation-menu"
            className="mobile-menu"
            padding={4}
            gap={2}
          >
            {links}
          </VStack>
        )}
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Chat key="chat" />} />
            <Route path="/feed" element={<Feed />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route
              path="/tasks/new"
              element={<Chat key="new-task" newTask />}
            />
            <Route
              path="/tasks/:taskId"
              element={<Chat key={location.pathname} />}
            />
            <Route path="/memories" element={<Memories />} />
            <Route path="/echo" element={<Echo />} />
            <Route path="/connections" element={<Connections />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="*"
              element={
                <Page title="This page has moved.">
                  <Button label="Go to Chat" href="/app/" />
                </Page>
              }
            />
          </Routes>
        </Suspense>
      </AppShell>
      <HStack
        as="nav"
        aria-label="Mobile navigation"
        className="mobile-dock"
        hAlign="around"
      >
        {nav.slice(0, 4).map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            aria-label={label}
            title={label}
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <Icon />
          </NavLink>
        ))}
      </HStack>
    </>
  );
}
function ProfileGate() {
  const profile = useProfile();
  const { api, signOut } = useSession();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<number>();
  const [error, setError] = useState<unknown>();
  if (profile.isPending) return <Loading label="Opening your space…" />;
  if (profile.error)
    return (
      <VStack padding={8}>
        <ErrorNotice
          error={profile.error}
          retry={() => void profile.refetch()}
        />
        <Button label="Sign out" onClick={() => void signOut()} />
      </VStack>
    );
  if (!profile.data.onboarded)
    return (
      <VStack className="onboarding" padding={6} gap={5}>
        <img className="welcome-robin" src="/app/assets/robin.webp" alt="" />
        <p className="eyebrow">Welcome to Impo</p>
        <h1>
          A personal agent.
          <br />A little more you.
        </h1>
        <p>
          Someone to help with the plans, questions and little things in your
          day. Give your personal agent a name and a face.
        </p>
        <TextInput
          label="Personal agent name"
          placeholder="e.g. Momo"
          value={name}
          onChange={setName}
        />
        <AvatarChoice value={avatar} onChange={setAvatar} />
        {!!error && <ErrorNotice error={error} />}
        <Button
          label="Make yourself at home"
          variant="primary"
          isDisabled={!name.trim() || avatar === undefined}
          clickAction={async () => {
            try {
              await api.mutate(
                "/profile",
                { assistantName: name, avatarIndex: avatar, onboarded: true },
                "PATCH",
              );
              await profile.refetch();
            } catch (e) {
              setError(e);
            }
          }}
        />
      </VStack>
    );
  return <Shell />;
}
function Account({ session }: { session: Session }) {
  const [cache] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15000,
            retry: (count, error) =>
              count < 2 && (!(error instanceof ApiError) || error.retryable),
            refetchOnWindowFocus: true,
          },
          mutations: { retry: false },
        },
      }),
  );
  useEffect(
    () => () => {
      session.api.close();
      void cache.cancelQueries();
      cache.clear();
    },
    [session, cache],
  );
  return (
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={cache}>
        <AccountRecovery>
          <ProfileGate />
        </AccountRecovery>
      </QueryClientProvider>
    </SessionContext.Provider>
  );
}
function SignedInAccount() {
  const { getToken, userId, sessionId } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const token = useRef(getToken);
  token.current = getToken;
  const session = useMemo<Session>(() => {
    const api = new ImpoClient(userId!, (refresh) =>
      token.current({ skipCache: refresh }),
    );
    return {
      api,
      account: userId!,
      email: user?.primaryEmailAddress?.emailAddress || "",
      fixture: false,
      manageAccount: () => clerk.openUserProfile(),
      signOut: async () => {
        api.close();
        clearAccountStorage(userId!, localStorage);
        await clerk.signOut({ redirectUrl: "/app/" });
      },
    };
  }, [userId, sessionId, user?.primaryEmailAddress?.emailAddress]);
  return <Account key={`${userId}:${sessionId}`} session={session} />;
}
function Login() {
  const path = useLocation().pathname;
  return (
    <HStack className="login-page" gap={0}>
      <VStack as="section" className="login-story" padding={8} gap={6}>
        <a className="brand" href="/">
          <img src="/app/assets/instant-mark.svg" alt="" />
          impo
        </a>
        <VStack gap={5} className="login-copy">
          <p className="eyebrow">Your personal agent</p>
          <h1>
            A little more
            <br />
            room for life.
          </h1>
          <p>
            Big plans. Small questions.
            <br />A thoughtful companion for all of it.
          </p>
          <img
            src="/app/assets/robin.webp"
            alt="An illustrated robin resting on a branch"
          />
        </VStack>
        <p className="muted">
          One personal agent, wherever your day takes you.
        </p>
      </VStack>
      <VStack className="login-form" gap={4} hAlign="center" vAlign="center">
        <h2>Make yourself at home.</h2>
        <p>Pick up where you left off.</p>
        <DeletionStatus />
        {path.startsWith("/sign-up") ? (
          <SignUp
            routing="path"
            path="/app/sign-up"
            signInUrl="/app/sign-in"
            forceRedirectUrl="/app/"
          />
        ) : (
          <SignIn
            routing="hash"
            signUpUrl="/app/sign-up"
            forceRedirectUrl="/app/"
          />
        )}
        <p className="legal">
          By continuing, you agree to our <a href="/terms/">Terms</a> and{" "}
          <a href="/privacy/">Privacy Policy</a>.
        </p>
      </VStack>
    </HStack>
  );
}
function Auth() {
  const { isLoaded, isSignedIn, userId, sessionId } = useAuth();
  if (!isLoaded) return <Loading label="Getting Impo ready…" />;
  return isSignedIn ? (
    <SignedInAccount key={`${userId}:${sessionId}`} />
  ) : (
    <Login />
  );
}
function Fixture() {
  const [account, setAccount] = useState("alice");
  const session = useMemo<Session>(
    () => ({
      api: new ImpoClient(account, async () => `instant-dev-${account}`),
      account,
      email: `${account}@example.test`,
      fixture: true,
      manageAccount: () => setAccount((v) => (v === "alice" ? "bob" : "alice")),
      signOut: async () => {
        clearAccountStorage(account, localStorage);
        setAccount((v) => (v === "alice" ? "bob" : "alice"));
      },
    }),
    [account],
  );
  return <Account key={account} session={session} />;
}
const fixture =
  import.meta.env.DEV &&
  import.meta.env.VITE_IMPO_FIXTURE === "1" &&
  ["localhost", "127.0.0.1"].includes(location.hostname);
const key =
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || "pk_live_Y2xlcmsuaW1wby5haSQ";
export default function App() {
  return (
    <Boundary>
      <Theme theme={impoTheme} mode="light">
        <style>{styles}</style>
        <BrowserRouter basename="/app">
          {fixture ? (
            <Fixture />
          ) : (
            <ClerkProvider
              publishableKey={key}
              signInUrl="/app/sign-in"
              signUpUrl="/app/sign-up"
              signInFallbackRedirectUrl="/app/"
              signUpFallbackRedirectUrl="/app/"
              appearance={{
                variables: {
                  colorPrimary: "#264d3d",
                  colorBackground: "#fcf8ee",
                  borderRadius: "0.8rem",
                  fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
                },
              }}
            >
              <Auth />
            </ClerkProvider>
          )}
        </BrowserRouter>
      </Theme>
    </Boundary>
  );
}
