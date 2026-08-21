import type { AutofillResult } from '../components/CollectionPage';

const API_KEY = import.meta.env.VITE_TMDB_API_KEY as string | undefined;
const BASE = 'https://api.themoviedb.org/3';
const IMG_THUMB = 'https://image.tmdb.org/t/p/w92';
const IMG_FULL = 'https://image.tmdb.org/t/p/w500';

export const tmdbConfigured = Boolean(API_KEY);

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDb request failed: ${res.status}`);
  return res.json();
}

async function resolveMovie(id: number, fallbackTitle: string): Promise<Record<string, unknown>> {
  const [details, credits, watch] = await Promise.all([
    fetchJson(`${BASE}/movie/${id}?api_key=${API_KEY}`),
    fetchJson(`${BASE}/movie/${id}/credits?api_key=${API_KEY}`).catch(() => null),
    fetchJson(`${BASE}/movie/${id}/watch/providers?api_key=${API_KEY}`).catch(() => null)
  ]);
  const director = credits?.crew?.find((c: any) => c.job === 'Director')?.name;
  const providers = watch?.results?.US?.flatrate?.map((p: any) => p.provider_name);
  return {
    title: details.title ?? fallbackTitle,
    mediaType: 'Movie',
    coverArt: details.poster_path ? `${IMG_FULL}${details.poster_path}` : undefined,
    director,
    releaseYear: details.release_date ? Number(details.release_date.slice(0, 4)) : undefined,
    genres: (details.genres ?? []).map((g: any) => g.name),
    description: details.overview || undefined,
    runtimeMin: details.runtime || undefined,
    whereToWatch: providers?.length ? providers : undefined
  };
}

async function resolveTv(id: number, fallbackTitle: string): Promise<Record<string, unknown>> {
  const details = await fetchJson(`${BASE}/tv/${id}?api_key=${API_KEY}`);
  return {
    title: details.name ?? fallbackTitle,
    mediaType: 'TV Series',
    coverArt: details.poster_path ? `${IMG_FULL}${details.poster_path}` : undefined,
    director: details.created_by?.[0]?.name,
    releaseYear: details.first_air_date ? Number(details.first_air_date.slice(0, 4)) : undefined,
    genres: (details.genres ?? []).map((g: any) => g.name),
    description: details.overview || undefined,
    seasonsEpisodes: details.number_of_seasons != null ? `${details.number_of_seasons} / ${details.number_of_episodes ?? '?'}` : undefined
  };
}

export async function searchMoviesAndTv(query: string): Promise<AutofillResult[]> {
  if (!API_KEY) return [];

  const [movieRes, tvRes] = await Promise.allSettled([
    fetchJson(`${BASE}/search/movie?query=${encodeURIComponent(query)}&api_key=${API_KEY}`),
    fetchJson(`${BASE}/search/tv?query=${encodeURIComponent(query)}&api_key=${API_KEY}`)
  ]);

  // A transient failure (rate limit, network hiccup) on both endpoints means the lookup
  // genuinely failed and should surface as a retryable error, same reasoning as igdb.ts — but
  // if only one side failed, the other's real results are still worth returning rather than
  // discarding a legitimate match for a coin-flip failure on the unrelated endpoint.
  if (movieRes.status === 'rejected' && tvRes.status === 'rejected') throw movieRes.reason;

  const movieData = movieRes.status === 'fulfilled' ? movieRes.value : { results: [] };
  const tvData = tvRes.status === 'fulfilled' ? tvRes.value : { results: [] };

  const movies: AutofillResult[] = (movieData.results ?? []).slice(0, 4).map((m: any) => ({
    label: `${m.title}${m.release_date ? ` · ${m.release_date.slice(0, 4)}` : ''} · Movie`,
    cover: m.poster_path ? `${IMG_THUMB}${m.poster_path}` : undefined,
    resolvePatch: () => resolveMovie(m.id, m.title)
  }));

  const tv: AutofillResult[] = (tvData.results ?? []).slice(0, 4).map((t: any) => ({
    label: `${t.name}${t.first_air_date ? ` · ${t.first_air_date.slice(0, 4)}` : ''} · TV`,
    cover: t.poster_path ? `${IMG_THUMB}${t.poster_path}` : undefined,
    resolvePatch: () => resolveTv(t.id, t.name)
  }));

  return [...movies, ...tv];
}
