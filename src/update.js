// explainroo update: sends the title, description and category of a package again
// to a video that is already up on YouTube, after post.json changed. With --cover it
// also sets the package's cover as the video's thumbnail, and with --captions it puts
// the package's captions in a track of the video's language, a new one or the one
// that is there. Privacy, the AI label and the file stay as they are. Like publish,
// it shows the change first and needs a typed yes, or --yes when there is no terminal.
//
// The video is the one publish posted from this package to this channel, found in
// the record by the file's sha256, or the one --video names. The record also keeps
// the sha256 of the cover and the captions sent, so the same file is not sent twice.
import fs from 'node:fs';
import path from 'node:path';
import { ProjectError, ServiceError, hideSecrets, hideSecretsIn } from './errors.js';
import { listAttempts, relativeFile, sha256File, shortId, updateJob } from './history.js';
import { LANGUAGE_NAMES } from './models.js';
import { DEFAULT_CATEGORY, withHashtags } from './post.js';
import { askYes, checkPair, checkYoutubeWords, chooseDestination, pickPlatform, publishKey, quoteBlock, readPackage } from './publish.js';
import youtube from './connectors/youtube.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// YouTube takes a cover of at most 2 MB.
const COVER_BYTES = 2 * 1024 * 1024;
// What YouTube keeps in a snippet that update sends back as it was. A PUT of a
// snippet replaces all of it, so a field left out would be cleared.
const KEEP = ['tags', 'defaultLanguage', 'defaultAudioLanguage'];

function fail(message) {
  throw new ProjectError(message);
}

function watchLink(id, platform) {
  return `https://www.youtube.com/${platform === 'shorts' ? `shorts/${id}` : `watch?v=${id}`}`;
}

// The lines of the old and the new text, each marked as kept (' '), gone ('-') or
// added ('+'), from the longest run of lines they share.
export function lineDiff(before, after) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

// The video to change: --video, or the newest post of this file to this channel
// that YouTube took.
function findVideo(dir, key, video) {
  const posted = listAttempts(dir, key).filter((job) => typeof job.job_id === 'string' && ['accepted', 'finished'].includes(job.stage));
  const job = posted.at(-1) ?? null;
  if (video !== undefined) return { id: video, job: posted.findLast((j) => j.job_id === video) ?? null };
  return job ? { id: job.job_id, job } : null;
}

export async function update(project, { log = () => {}, notice = () => {}, ...options } = {}) {
  const r = await updateVideo(project, { ...options, log: (line) => log(hideSecrets(line)), notice: (line) => notice(hideSecrets(line)) });
  return hideSecretsIn(r);
}

async function updateVideo(project, { via, platform: asked, video, cover: withCover = false, captions: withCaptions = false, dryRun = false, yes = false, notice, ask = askYes } = {}) {
  const { dir } = project;
  if (via === undefined) fail('update needs --via youtube');
  if (via !== 'youtube') fail('update works only --via youtube. Change a post that went through Buffer or Blotato in that service. Nothing was changed.');
  if (video !== undefined && !VIDEO_ID.test(video)) fail(`--video takes the 11 characters of a YouTube video id, like the part after watch?v= in its link. "${video}" is not one. Nothing was changed.`);
  const platform = pickPlatform(project, via, asked);
  const network = checkPair(via, platform);
  const pkg = readPackage(project, platform);
  checkYoutubeWords(network, pkg);
  const login = youtube.login(dir);
  if (!login.ok) fail(`${login.missing} Nothing was changed.`);
  const chosen = await chooseDestination(via, network, dir, {});
  if (!chosen.destination) fail(`${chosen.missing} Nothing was changed.`);
  const destination = { id: chosen.destination.id, name: chosen.destination.name };
  const found = findVideo(dir, publishKey(via, pkg.sha256, network, destination), video);
  if (!found) fail(`the record has no post of this ${platform} package to ${destination.name}, so update does not know which video to change. When the video went up another way, or from a package that was made again with another file, name it with --video <id>. Nothing was changed.`);

  let current;
  try {
    current = await youtube.readWords(dir, found.id);
  } catch (e) {
    if (e instanceof ServiceError) fail(`the video ${found.id} could not be read: ${e.message}. Nothing was changed.`);
    throw e;
  }
  if (!current) fail(`YouTube lists no video ${found.id} for this login. It may have been deleted, or it is on another channel. Nothing was changed.`);
  if (current.channelId && current.channelId !== destination.id) fail(`the video ${found.id} is on another channel than the one of this login (${destination.name}). Nothing was changed.`);

  const post = pkg.post;
  const next = { title: post.title, description: withHashtags(post.description.trim(), post.hashtags), categoryId: String(post.category) };
  for (const field of KEEP) if (current[field] !== undefined) next[field] = current[field];
  const changes = ['title', 'description', 'categoryId'].filter((field) => (current[field] ?? '') !== next[field]);
  const job = found.job;
  const cover = withCover ? coverPlan(project, pkg, job) : null;
  const captions = withCaptions ? await captionsPlan(project, pkg, job, found.id) : null;
  const plan = {
    video: { id: found.id, link: watchLink(found.id, platform), job: job ? shortId(job) : null },
    platform,
    destination,
    changes,
    title: { before: current.title ?? '', after: next.title },
    description: { before: current.description ?? '', after: next.description },
    category: { before: current.categoryId ?? null, after: next.categoryId },
    cover,
    captions,
  };
  const sends = [...(changes.length ? ['words'] : []), ...(cover?.action === 'set' ? ['cover'] : []), ...(captions && captions.action !== 'already' ? ['captions'] : [])];
  const base = { via, platform, video: plan.video, destination };
  if (!sends.length) return { ...base, dry_run: dryRun, sends: [], changed: [], plan };
  const request = {
    ...(changes.length ? { words: { id: found.id, snippet: next } } : {}),
    ...(sends.includes('cover') ? { cover: cover.file } : {}),
    ...(sends.includes('captions') ? { captions: { file: captions.file, language: captions.language, track: captions.track?.id ?? null } } : {}),
  };
  if (dryRun) return { ...base, dry_run: true, would: 'update', sends, changed: changes, plan, request };

  notice(`This is the change. Nothing has been sent yet.\n${planText(plan)}`);
  if (!(await confirmed({ yes, ask }))) {
    return { ok: false, dry_run: false, confirmed: false, error: 'Nothing was changed. There is no terminal here to type yes. Show this change to the user, and if they say yes, run the same command with --yes.', plan, request };
  }
  // Each part goes on its own. A part YouTube refuses is reported, and the others
  // still go. Only a login that can't change videos stops the run.
  const results = {};
  const record = (fields) => {
    if (job) updateJob(dir, job, fields);
  };
  if (changes.length) {
    try {
      const sent = await youtube.updateWords(dir, found.id, next);
      results.words = { ok: true, arrived: !!sent && sent.title === next.title && sent.description === next.description };
      record({ words_updated: new Date().toISOString(), words_updated_title: next.title });
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
      results.words = { ok: false, error: partError(e, 'words') };
    }
  }
  if (sends.includes('cover')) {
    try {
      await youtube.setThumbnail(dir, found.id, path.join(dir, cover.file));
      results.cover = { ok: true };
      record({ cover_sha256: cover.sha256, cover_set: new Date().toISOString() });
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
      results.cover = { ok: false, error: partError(e, 'cover') };
    }
  }
  if (sends.includes('captions')) {
    try {
      const answer = await youtube.putCaptions(dir, { trackId: captions.track?.id ?? null, videoId: found.id, language: captions.language, name: captions.name, file: path.join(dir, captions.file) });
      results.captions = { ok: true, track: typeof answer.id === 'string' ? answer.id : captions.track?.id ?? null };
      record({ captions_sha256: captions.sha256, captions_set: new Date().toISOString(), captions_track: results.captions.track });
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
      results.captions = { ok: false, error: partError(e, 'captions') };
    }
  }
  const failed = Object.values(results).some((r) => !r.ok);
  return { ...base, dry_run: false, sends, changed: changes, results, failed, plan };
}

const PART_NAMES = { words: 'the words', cover: 'the cover', captions: 'the captions' };

function partError(e, part) {
  const where = PART_NAMES[part];
  const after = e.outcome === 'later' ? `It is not known whether ${where} arrived. Run the same command again.` : `${where[0].toUpperCase()}${where.slice(1)} did not change.`;
  return `${e.message.replace(/\.$/, '')}. ${after}`;
}

// The cover of the package, and whether this video got this exact picture before.
function coverPlan(project, pkg, job) {
  const file = path.join(pkg.folder, 'video.cover.jpg');
  const name = relativeFile(project.dir, file);
  if (!fs.existsSync(file)) fail(`there is no cover in the package (${name}). Run ${pkg.again} again. Nothing was changed.`);
  const bytes = fs.statSync(file).size;
  if (bytes > COVER_BYTES) fail(`${name} is ${(bytes / 1e6).toFixed(1)} MB, and YouTube takes a cover of at most 2 MB. Nothing was changed.`);
  const sha256 = sha256File(file);
  return { file: name, bytes, sha256, action: job?.cover_sha256 === sha256 ? 'already' : 'set', set: job?.cover_set ?? null };
}

// YouTube's language code for the video's language: pt-br is pt-BR there.
function captionLanguage(language) {
  return language.replace(/-(\w+)$/, (m, region) => `-${region.toUpperCase()}`);
}

// The captions of the package, and the track they go into: a track of the same
// language that a person added, or a new one. YouTube's own automatic track is
// never touched.
async function captionsPlan(project, pkg, job, id) {
  const file = path.join(pkg.folder, 'video.srt');
  const name = relativeFile(project.dir, file);
  if (!fs.existsSync(file)) fail(`there are no captions in the package (${name}). Run ${pkg.again} again. Nothing was changed.`);
  const code = project.config?.language ?? 'en';
  const language = captionLanguage(code);
  let tracks;
  try {
    tracks = await youtube.listCaptions(project.dir, id);
  } catch (e) {
    if (e instanceof ServiceError && /insufficientPermissions|scope/i.test(e.message)) fail('the saved YouTube login can\'t read or change captions, because it was made before explainroo asked for that. Run "explainroo connect youtube" again to sign in, then run the same command. Nothing was changed.');
    if (e instanceof ServiceError) fail(`the captions of the video ${id} could not be read: ${e.message}. Nothing was changed.`);
    throw e;
  }
  const own = tracks.filter((t) => t.snippet.trackKind !== 'asr' && String(t.snippet.language).toLowerCase() === language.toLowerCase());
  const track = own.find((t) => t.id === job?.captions_track) ?? own[0] ?? null;
  const sha256 = sha256File(file);
  const lines = (fs.readFileSync(file, 'utf8').match(/-->/g) ?? []).length;
  const action = track && job?.captions_sha256 === sha256 && job?.captions_track === track.id ? 'already' : track ? 'replace' : 'add';
  return { file: name, sha256, lines, language, name: LANGUAGE_NAMES[code] ?? language, action, track: track ? { id: track.id, name: track.snippet.name ?? '' } : null };
}

async function confirmed({ yes, ask }) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  return ask('Type yes to change this video under your name, or anything else to stop: ');
}

function kilobytes(bytes) {
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

export function planText(plan) {
  const lines = [
    `Video:     ${plan.video.link} (id ${plan.video.id}${plan.video.job ? `, posted by job ${plan.video.job}` : ''})`,
    `Channel:   ${plan.destination.name} on YouTube (id ${plan.destination.id})`,
  ];
  if (plan.title.before === plan.title.after) lines.push(`Title:     ${plan.title.after} (unchanged)`);
  else lines.push(`Title:     ${plan.title.before}`, `     now:  ${plan.title.after}`);
  if (plan.description.before === plan.description.after) lines.push('Description: unchanged');
  else lines.push('Description, - goes and + comes:', quoteBlock(lineDiff(plan.description.before, plan.description.after).map(([mark, line]) => `${mark} ${line}`).join('\n')));
  const category = (c) => `${c}${String(c) === String(DEFAULT_CATEGORY) ? ' (Education)' : ''}`;
  lines.push(`Category:  ${plan.category.before === plan.category.after ? `${category(plan.category.after)} (unchanged)` : `${category(plan.category.before)} becomes ${category(plan.category.after)}`}`);
  const c = plan.cover;
  if (!c) lines.push('Cover:     not sent. Add --cover to set the package\'s cover.');
  else if (c.action === 'already') lines.push(`Cover:     ${c.file}, already set on this video${c.set ? ` on ${c.set.slice(0, 10)}` : ''}, not sent again`);
  else lines.push(`Cover:     ${c.file} (${kilobytes(c.bytes)}) becomes the thumbnail`);
  const t = plan.captions;
  if (!t) lines.push('Captions:  not sent. Add --captions to put the package\'s captions on the video.');
  else {
    const what = {
      already: `are already in the ${t.language} track "${t.track?.name}", not sent again`,
      replace: `go into the ${t.language} track "${t.track?.name}", in place of what it has`,
      add: `go up as a new ${t.language} track "${t.name}"`,
    }[t.action];
    lines.push(`Captions:  ${t.file} (${t.lines} lines) ${what}`);
  }
  lines.push('Privacy, the AI label and the file stay as they are.');
  return lines.join('\n');
}

export function formatUpdate(r) {
  if (r.confirmed === false) return '';
  if (!r.sends.length) {
    const parts = ['words', ...(r.plan.cover ? ['cover'] : []), ...(r.plan.captions ? ['captions'] : [])];
    const said = parts.length === 1 ? 'these words' : `these ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
    return [`The video already has ${said}, so nothing was sent.`, `Link: ${r.video.link}`].join('\n');
  }
  if (r.dry_run) return [`This is the change a real run would send. Nothing was sent.\n${planText(r.plan)}`, 'The real run shows this again and changes the video only after a typed yes, or with --yes when there is no terminal.'].join('\n');
  const fields = r.changed.map((f) => ({ title: 'title', description: 'description', categoryId: 'category' }[f])).join(', ');
  const lines = [];
  for (const part of r.sends) {
    const res = r.results[part];
    if (!res.ok) lines.push(`Not changed, ${PART_NAMES[part]}: ${res.error}`);
    else if (part === 'words') lines.push(`Changed the ${fields}.${res.arrived ? '' : ' YouTube answered without the new words. Look at the video in YouTube Studio.'}`);
    else if (part === 'cover') lines.push('Set the cover.');
    else lines.push(`${r.plan.captions.action === 'replace' ? 'Replaced' : 'Added'} the ${r.plan.captions.language} captions.`);
  }
  lines.push(`Link: ${r.video.link}`, `YouTube Studio: https://studio.youtube.com/video/${r.video.id}/edit`);
  return lines.join('\n');
}
