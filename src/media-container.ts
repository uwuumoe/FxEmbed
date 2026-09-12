import { Container } from '@cloudflare/containers';

export class MediaTranscoderV2 extends Container {
  defaultPort = 8787;
  sleepAfter = '10m';
}
