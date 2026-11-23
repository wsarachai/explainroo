// explainroo update: sends the title, description and category of a package again
// to a video that is already up on YouTube, after post.json changed. It changes only
// those words. Privacy, the AI label, the cover, the captions and the file stay as
// they are. Like publish, it shows the change first and needs a typed yes, or --yes
// when there is no terminal.
//
// The video is the one publish posted from this package to this channel, found in
// the record by the file's sha256, or the one --video names.
import { ProjectError, ServiceError, hideSecrets, hideSecretsIn } from './errors.js';
import { listAttempts, shortId, updateJob } from './history.js';
import { DEFAULT_CATEGORY, withHashtags } from './post.js';
import { askYes, checkPair, checkYoutubeWords, chooseDestination, pickPlatform, publishKey, quoteBlock, readPackage } from './publish.js';
import youtube from './connectors/youtube.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
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

async function updateVideo(project, { via, platform: asked, video, dryRun = false, yes = false, notice, ask = askYes } = {}) {
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
  const plan = {
    video: { id: found.id, link: watchLink(found.id, platform), job: found.job ? shortId(found.job) : null },
    platform,
    destination,
    changes,
    title: { before: current.title ?? '', after: next.title },
    description: { before: current.description ?? '', after: next.description },
    category: { before: current.categoryId ?? null, after: next.categoryId },
  };
  const base = { via, platform, video: plan.video, destination };
  if (!changes.length) return { ...base, dry_run: dryRun, changed: [], plan };
  if (dryRun) return { ...base, dry_run: true, would: 'update', changed: changes, plan, request: { id: found.id, snippet: next } };

  notice(`This is the change. Nothing has been sent yet.\n${planText(plan)}`);
  if (!(await confirmed({ yes, ask }))) {
    return { ok: false, dry_run: false, confirmed: false, error: 'Nothing was changed. There is no terminal here to type yes. Show this change to the user, and if they say yes, run the same command with --yes.', plan, request: { id: found.id, snippet: next } };
  }
  let sent;
  try {
    sent = await youtube.updateWords(dir, found.id, next);
  } catch (e) {
    if (e instanceof ServiceError) fail(`${e.message}. ${e.outcome === 'later' ? 'It is not known whether the change arrived. Run the same command again: it reads the video first and sends the change only when it is still needed.' : 'Nothing was changed.'}`);
    throw e;
  }
  const arrived = !!sent && sent.title === next.title && sent.description === next.description;
  if (found.job) updateJob(dir, found.job, { words_updated: new Date().toISOString(), words_updated_title: next.title });
  return { ...base, dry_run: false, changed: changes, arrived, plan };
}

async function confirmed({ yes, ask }) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  return ask('Type yes to change this video under your name, or anything else to stop: ');
}

const FIELD_WORDS = { title: 'title', description: 'description', categoryId: 'category' };

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
  lines.push('Only these words change. Privacy, the AI label, the cover, the captions and the file stay as they are.');
  return lines.join('\n');
}

export function formatUpdate(r) {
  if (r.confirmed === false) return '';
  const fields = (list) => list.map((f) => FIELD_WORDS[f]).join(', ');
  if (!r.changed.length) return [`The video already has these words, so nothing was sent.`, `Link: ${r.video.link}`].join('\n');
  if (r.dry_run) return [`This is the change a real run would send. Nothing was sent.\n${planText(r.plan)}`, 'The real run shows this again and changes the video only after a typed yes, or with --yes when there is no terminal.'].join('\n');
  return [
    `Changed the ${fields(r.changed)} of the video on ${r.destination.name}.`,
    ...(r.arrived ? [] : ['YouTube answered without the new words. Look at the video in YouTube Studio.']),
    `Link: ${r.video.link}`,
    `YouTube Studio: https://studio.youtube.com/video/${r.video.id}/edit`,
  ].join('\n');
}
