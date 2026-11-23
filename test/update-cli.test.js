// update through the real command line against the fake YouTube: it changes the
// words of a video publish posted, and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers/publishing.js';
import { lineDiff } from '../src/update.js';

const EDIT = 'PUT /youtube/v3/videos';

// Posts the youtube package, then changes its post.json the way package would
// after post.json changed: same file, new words.
async function posted(t, options = {}) {
  const s = await setup(t, { platforms: ['youtube'], login: ['youtube'], ...options });
  const r = await s.json('--via', 'youtube', '--yes');
  assert.equal(r.code, 0, r.text);
  const file = path.join(s.dir, 'out/package/youtube/post.json');
  const words = (change) => {
    const post = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...post, ...change }, null, 2));
  };
  const update = async (...args) => {
    const out = await s.cli(['update', s.dir, ...args, '--json']);
    try {
      return { ...out, out: JSON.parse(out.stdout) };
    } catch {
      return { ...out, out: null };
    }
  };
  const human = (...args) => s.cli(['update', s.dir, ...args]);
  return { ...s, id: r.out.post.id, words, update, human };
}

test('update changes only the words of the posted video, after a dry run that sends nothing', async (t) => {
  const { fake, id, words, update, human, jobs } = await posted(t);
  fake.publishing.youtube.videos.get(id).snippet.tags = ['dns', 'network'];
  words({ description: 'Your browser asks a resolver for the address.\nSlides: https://example.com/slides' });

  const dry = await update('--via', 'youtube', '--dry-run');
  assert.equal(dry.code, 0, dry.text);
  assert.equal(dry.out.would, 'update');
  assert.deepEqual(dry.out.changed, ['description']);
  assert.equal(dry.out.video.id, id);
  assert.equal(fake.count('youtube', EDIT), 0, 'a dry run sends nothing');
  const shown = await human('--via', 'youtube', '--dry-run');
  assert.match(shown.stdout, /^ {11}\| \+ Slides: https:\/\/example\.com\/slides$/m);
  assert.match(shown.stdout, /^Title: {5}How DNS finds a website \(unchanged\)$/m);

  const real = await update('--via', 'youtube', '--yes');
  assert.equal(real.code, 0, real.text);
  assert.equal(real.out.arrived, true);
  const [sent] = fake.requests('youtube', EDIT);
  assert.deepEqual(sent.body, dry.out.request, 'the real run sends what the dry run showed');
  const video = fake.publishing.youtube.videos.get(id);
  assert.equal(video.snippet.description, 'Your browser asks a resolver for the address.\nSlides: https://example.com/slides\n\n#dns');
  assert.deepEqual(video.snippet.tags, ['dns', 'network'], 'the tags stay');
  assert.equal(video.status.privacyStatus, 'private', 'the privacy stays');
  assert.ok(jobs().some((job) => job.words_updated), 'the record says when the words changed');

  const again = await update('--via', 'youtube', '--yes');
  assert.equal(again.code, 0, again.text);
  assert.deepEqual(again.out.changed, []);
  assert.equal(fake.count('youtube', EDIT), 1, 'words that are there already are not sent again');
});

test('update needs a yes, and without a terminal it changes nothing', async (t) => {
  const { fake, words, update } = await posted(t);
  words({ title: 'How DNS finds a site' });
  const r = await update('--via', 'youtube');
  assert.equal(r.code, 1);
  assert.equal(r.out.confirmed, false);
  assert.equal(fake.count('youtube', EDIT), 0);
});

test('a login from before update says to sign in again, and changes nothing', async (t) => {
  const { fake, envFile, words, update } = await posted(t);
  const lines = fake.login('youtube', { old: true });
  fs.writeFileSync(envFile, Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(''));
  words({ title: 'How DNS finds a site' });
  const r = await update('--via', 'youtube', '--yes');
  assert.equal(r.code, 1);
  assert.match(r.text, /can upload videos but not change them.*connect youtube.*Nothing was changed\./s);
  assert.equal(fake.publishing.youtube.videos.values().next().value.snippet.title, 'How DNS finds a website');
});

test('without a post in the record update asks for --video, and --video must look like an id', async (t) => {
  const { fake, update, id, dir } = await posted(t);
  fs.rmSync(path.join(dir, 'history'), { recursive: true, force: true });
  const none = await update('--via', 'youtube', '--dry-run');
  assert.equal(none.code, 1);
  assert.match(none.text, /--video <id>/);
  const bad = await update('--via', 'youtube', '--video', 'not an id', '--dry-run');
  assert.equal(bad.code, 1);
  assert.match(bad.text, /11 characters/);
  const missing = await update('--via', 'youtube', '--video', 'AAAAAAAAAAA', '--dry-run');
  assert.equal(missing.code, 1);
  assert.match(missing.text, /lists no video AAAAAAAAAAA/);
  assert.equal(fake.count('youtube', EDIT), 0);
  assert.ok(id);
});

test('update refuses the other services', async (t) => {
  const { update } = await posted(t);
  const r = await update('--via', 'buffer', '--dry-run');
  assert.equal(r.code, 1);
  assert.match(r.text, /only --via youtube/);
});

test('lineDiff marks the lines that go and come', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nx\nc\nd'), [[' ', 'a'], ['-', 'b'], ['+', 'x'], [' ', 'c'], ['+', 'd']]);
});
