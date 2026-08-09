// Synthesised thunder, for the live lightning watch.
//
// No audio files: a burst of brown noise pushed through a low-pass filter. The
// filter cutoff and the shape of the envelope are set by how far away the
// strike was, which is what actually distinguishes a crack overhead from a
// rumble on the horizon — air absorbs the high frequencies first, so distance
// takes the edge off the sound and stretches it out.

let ctx = null;
let noiseBuffer = null;
let muted = false;

/**
 * Brown-ish noise. Integrating white noise tilts the spectrum downwards, which
 * is what makes it read as a rumble instead of a hiss.
 */
function makeNoise(audio, seconds) {
  const buffer = audio.createBuffer(1, Math.floor(audio.sampleRate * seconds), audio.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = Math.max(-1, Math.min(1, last * 3.5));
  }
  return buffer;
}

/**
 * Build (or wake) the audio context. Browsers only allow this from a real
 * gesture, so it is called from the Watch button's click handler.
 */
export function primeThunder() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    ctx = new Ctor();
    noiseBuffer = makeNoise(ctx, 3);
  }
  ctx.resume?.();
  return ctx;
}

export function setThunderMuted(value) {
  muted = Boolean(value);
}

export function isThunderMuted() {
  return muted;
}

/** Play one clap, coloured by how far away the strike was. */
export function thunder(distanceMiles) {
  if (!ctx || muted || ctx.state !== 'running') return;

  // 1 for a strike overhead, tailing to 0 at the far edge of the widest ring.
  const near = Math.max(0, 1 - distanceMiles / 25);
  const now = ctx.currentTime;

  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;
  source.playbackRate.value = 0.7 + near * 0.5;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 180 + near * near * 3200;
  lowpass.Q.value = 0.7;

  const gain = ctx.createGain();
  const peak = 0.1 + near * 0.45;
  const attack = 0.005 + (1 - near) * 0.45; // close: a crack. far: a swell.
  const length = 1.2 + (1 - near) * 2.5;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + length);

  source.connect(lowpass).connect(gain).connect(ctx.destination);
  // Start at a random offset so repeated claps never sound identical.
  source.start(now, Math.random() * 0.5);
  source.stop(now + length + 0.1);
}
