import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";

interface LocationState {
  pathname: string;
  search: string;
  hash: string;
}

interface NavigateOptions {
  replace?: boolean;
}

type Navigate = (to: string, options?: NavigateOptions) => void;

interface RouterState {
  location: LocationState;
  navigate: Navigate;
}

const RouterContext = createContext<RouterState | undefined>(undefined);
const internalBase = "https://bored-manager.invalid";

function parseLocation(value: string, base = internalBase): LocationState {
  const url = new URL(value, base);
  return { pathname: url.pathname || "/", search: url.search, hash: url.hash };
}

function currentBrowserLocation(): LocationState {
  return parseLocation(window.location.href, window.location.origin);
}

function useRouter(): RouterState {
  const state = useContext(RouterContext);
  if (!state) throw new Error("router hooks must be used inside BrowserRouter or MemoryRouter");
  return state;
}

export function BrowserRouter({ children }: PropsWithChildren) {
  const [location, setLocation] = useState(currentBrowserLocation);

  useEffect(() => {
    const handlePopState = () => setLocation(currentBrowserLocation());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback<Navigate>((to, options = {}) => {
    const target = new URL(to, window.location.href);
    if (target.origin !== window.location.origin) throw new Error("router navigation must remain same-origin");
    const next = `${target.pathname}${target.search}${target.hash}`;
    if (options.replace) window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
    setLocation(currentBrowserLocation());
  }, []);

  const state = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={state}>{children}</RouterContext.Provider>;
}

export function MemoryRouter({ initialEntries = ["/"], children }: PropsWithChildren<{ initialEntries?: string[] }>) {
  const [location, setLocation] = useState(() => parseLocation(initialEntries.at(-1) ?? "/"));
  const navigate = useCallback<Navigate>((to) => setLocation((current) => parseLocation(to, `${internalBase}${current.pathname}${current.search}`)), []);
  const state = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={state}>{children}</RouterContext.Provider>;
}

export function useLocation(): LocationState {
  return useRouter().location;
}

export function useNavigate(): Navigate {
  return useRouter().navigate;
}

type SearchParamsInput = URLSearchParams | Record<string, string>;

export function useSearchParams(): [URLSearchParams, (next: SearchParamsInput) => void] {
  const { location, navigate } = useRouter();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const setParams = useCallback((next: SearchParamsInput) => {
    const value = next instanceof URLSearchParams ? next : new URLSearchParams(next);
    const query = value.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ""}${location.hash}`, { replace: true });
  }, [location.hash, location.pathname, navigate]);
  return [params, setParams];
}

interface NavLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "href"> {
  to: string;
  className?: string | ((state: { isActive: boolean }) => string);
}

export function NavLink({ to, className, onClick, target, ...props }: NavLinkProps) {
  const { location, navigate } = useRouter();
  const targetLocation = parseLocation(to, `${internalBase}${location.pathname}${location.search}`);
  const isActive = targetLocation.pathname === location.pathname;

  function follow(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || target) return;
    event.preventDefault();
    navigate(to);
  }

  return <a {...props} href={to} target={target} onClick={follow} className={typeof className === "function" ? className({ isActive }) : className} />;
}

interface RouteProps {
  path: string;
  element: ReactNode;
}

export function Route(_: RouteProps) {
  return null;
}

export function Routes({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const routes = Children.toArray(children).filter((child): child is ReactElement<RouteProps> => isValidElement<RouteProps>(child));
  return <>{(routes.find((route) => route.props.path === pathname) ?? routes.find((route) => route.props.path === "*"))?.props.element ?? null}</>;
}

export function Navigate({ to, replace = false }: { to: string; replace?: boolean }) {
  const navigate = useNavigate();
  useEffect(() => navigate(to, { replace }), [navigate, replace, to]);
  return null;
}
