import { Container } from '@cloudflare/containers';

export class MediaTranscoder extends Container {
  defaultPort = 8787;
  sleepAfter = '10m';
}

export class MediaTranscoderV2 extends Container {
  defaultPort = 8787;
  sleepAfter = '10m';
}
