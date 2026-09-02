import {
  useLocation,
  useNavigate,
  useParams as useRouterParams,
  useSearchParams as useRouterSearchParams,
} from 'react-router-dom';

function formatHref(href) {
  if (href == null) return '/';
  if (typeof href === 'string') return href;

  const pathname = href.pathname ?? '/';
  const query = href.query
    ? `?${new URLSearchParams(href.query).toString()}`
    : '';
  const hash = href.hash ? String(href.hash) : '';

  return `${pathname}${query}${hash}`;
}

export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (href) => navigate(formatHref(href)),
    replace: (href) => navigate(formatHref(href), { replace: true }),
    refresh: () => {
      window.location.reload();
    },
    back: () => navigate(-1),
    forward: () => navigate(1),
    prefetch: () => Promise.resolve(),
  };
}

export function useSearchParams() {
  const [searchParams] = useRouterSearchParams();
  return searchParams;
}

export function usePathname() {
  return useLocation().pathname;
}

export function useParams() {
  return useRouterParams();
}

export function redirect(href) {
  window.location.replace(formatHref(href));
}

export function notFound() {
  throw new Error('Not found');
}

export const useSelectedLayoutSegment = () => null;
export const useSelectedLayoutSegments = () => [];
export const permanentRedirect = redirect;
