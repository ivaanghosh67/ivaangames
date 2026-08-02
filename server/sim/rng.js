// Seeded PRNG (mulberry32).
//
// The original game calls Math.random() in ~30 places. On an authoritative
// server that is still *correct* — the server is the only one rolling dice —
// but a seeded generator buys three things worth having:
//   1. a room's map and wave rolls can be reproduced from the seed alone,
//   2. bug reports become replayable ("room seed 812934, wave 17"),
//   3. clients can generate the identical map locally from the seed instead of
//      us shipping the whole waypoint list every snapshot.

export function makeRng(seed) {
  let a = seed >>> 0;
  const rnd = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rnd.int = n => Math.floor(rnd() * n);
  rnd.range = (lo, hi) => lo + rnd() * (hi - lo);
  rnd.pick = arr => arr[Math.floor(rnd() * arr.length)];
  rnd.seed = seed >>> 0;
  return rnd;
}

// A room code people can say out loud. No vowels (avoids accidental words),
// no 0/O/1/I/L (avoids misreads over voice or a screenshot).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeRoomCode(rnd, len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[rnd.int(CODE_ALPHABET.length)];
  return s;
}
