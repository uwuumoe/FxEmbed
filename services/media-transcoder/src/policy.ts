import { URL } from 'node:url';

const TWITTER_HOSTS = new Set(['video.twimg.com', 'pbs.twimg.com']);
const BLUESKY_HOSTS = new Set(['cdn.bsky.app', 'bsky.network']);
const PRIVATE_HOST =
  /^(localhost|0|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fc|fd)/i;
const CID = /^[a-zA-Z0-9][a-zA-Z0-9._~-]{10,}$/;
const DID = /^did:plc:[a-z2-7]{20,}$/;

export const isAllowedSource = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      PRIVATE_HOST.test(url.hostname)
    )
      return false;
    return (
      TWITTER_HOSTS.has(url.hostname) ||
      BLUESKY_HOSTS.has(url.hostname) ||
      url.hostname.endsWith('.bsky.network')
    );
  } catch {
    return false;
  }
};

export const buildSourceUrl = (pathname: string): string => {
  if (!/^\/tweet_video\/[A-Za-z0-9._-]+\.(?:mp4|webm)$/i.test(pathname))
    throw new Error('invalid media path');
  return `https://video.twimg.com${pathname}`;
};

export const outputFormat = (pathname: string): 'webp' | 'gif' => {
  const ext = pathname.toLowerCase().split('.').pop();
  if (ext !== 'webp' && ext !== 'gif') throw new Error('unsupported output format');
  return ext;
};

export const mosaicSourceUrls = (urls: string[]): string[] => {
  if (urls.length < 1 || urls.length > 4 || urls.some(url => !isAllowedSource(url)))
    throw new Error('mosaic must contain one to four allowed sources');
  return urls;
};

export const isAllowedPdsBlob = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !PRIVATE_HOST.test(url.hostname) &&
      (url.hostname === 'cdn.bsky.app' || url.hostname.endsWith('.bsky.network'))
    );
  } catch {
    return false;
  }
};

export const buildPdsBlobUrl = (did: string, cid: string): string => {
  if (!DID.test(did) || !CID.test(cid)) throw new Error('invalid DID or CID');
  return `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}@jpeg`;
};

export const buildBlueskyVideoUrl = (base: string, did: string, cid: string): string => {
  if (!DID.test(did) || !CID.test(cid)) throw new Error('invalid DID or CID');
  const root = new URL(base);
  if (root.protocol !== 'https:' || PRIVATE_HOST.test(root.hostname))
    throw new Error('invalid video host');
  return `${root.toString().replace(/\/$/, '')}/${did}/${cid}`;
};

export const isDid = (value: string) => DID.test(value);
