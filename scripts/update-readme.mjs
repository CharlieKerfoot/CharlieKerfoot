import { readFile, writeFile } from "node:fs/promises";

const USER = process.env.GH_USER || "CharlieKerfoot";
const EMAIL = process.env.CO_AUTHOR_EMAIL || "charliekerfoot@gmail.com";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GITHUB_TOKEN required");

const gh = async (path, params = {}) => {
  const url = new URL(`https://api.github.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}: ${await res.text()}`);
  return res.json();
};

const paginate = async (path, baseParams, maxPages = 5) => {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await gh(path, { ...baseParams, page: String(page) });
    items.push(...data.items);
    if (data.items.length < 100) break;
  }
  return items;
};

const fetchProject = async (slug) => {
  if (slug.includes("REPLACE-ME")) return null;
  try {
    const r = await gh(`/repos/${slug}`);
    return {
      name: r.name,
      description: r.description || "",
      url: r.html_url,
      stars: r.stargazers_count,
      language: r.language,
    };
  } catch (e) {
    console.error(`Skipping ${slug}: ${e.message}`);
    return null;
  }
};

const renderProjects = (projects) => {
  if (!projects.length) return "_No projects configured yet — edit `projects.json`._";
  return projects
    .map((p) => {
      const meta = [p.language && `\`${p.language}\``/*, p.stars > 0 && `★ ${p.stars}`*/]
        .filter(Boolean)
        .join(" · ");
      const desc = p.description ? ` — ${p.description}` : "";
      return `- **[${p.name}](${p.url})**${meta ? ` ${meta}` : ""}${desc}`;
    })
    .join("\n");
};

const fetchAllUserPRs = () =>
  paginate("/search/issues", {
    q: `author:${USER} type:pr is:public -user:${USER}`,
    per_page: "100",
    sort: "updated",
    order: "desc",
  });

const slugFromUrl = (apiUrl) =>
  apiUrl.replace("https://api.github.com/repos/", "");

// For a closed-not-merged PR, follow its timeline for a cross-referenced
// sibling PR in the same repo that was merged. Maintainers sometimes close
// a contributor PR and re-open their own PR with the same fix.
const findMergedSibling = async (pr) => {
  const slug = slugFromUrl(pr.repository_url);
  let timeline;
  try {
    timeline = await gh(`/repos/${slug}/issues/${pr.number}/timeline`, {
      per_page: "100",
    });
  } catch (e) {
    console.error(`timeline ${slug}#${pr.number}: ${e.message}`);
    return null;
  }

  const candidates = [];
  for (const ev of timeline) {
    if (ev.event !== "cross-referenced") continue;
    const src = ev.source?.issue;
    if (!src?.pull_request) continue;
    if (!src.repository_url?.endsWith(`/${slug}`)) continue;
    if (src.user?.login === USER) continue;
    candidates.push(src);
  }

  for (const c of candidates) {
    try {
      const full = await gh(`/repos/${slug}/pulls/${c.number}`);
      if (full.merged_at) {
        return {
          number: full.number,
          html_url: full.html_url,
          closed_at: full.merged_at,
          repository_url: pr.repository_url,
        };
      }
    } catch (e) {
      console.error(`pull ${slug}#${c.number}: ${e.message}`);
    }
  }
  return null;
};

const fetchCommits = (query) =>
  paginate("/search/commits", {
    q: query,
    per_page: "100",
    sort: "author-date",
    order: "desc",
  });

// Format: { repo: { prs: [{number, url, mergedAt}], commits: [{sha, url, date}] } }
const buildContributionMap = (prs, commits) => {
  const map = new Map();
  const get = (slug) => {
    if (!map.has(slug)) map.set(slug, { prs: [], commits: [] });
    return map.get(slug);
  };

  for (const pr of prs) {
    const slug = slugFromUrl(pr.repository_url);
    get(slug).prs.push({
      number: pr.number,
      url: pr.html_url,
      mergedAt: pr.closed_at,
    });
  }

  // Dedupe commits that are just the squash-merge commit of one of our merged PRs.
  // GitHub's default squash format: "Title (#1234)". If that PR number is one
  // of ours in the same repo, skip — it's the same contribution.
  for (const c of commits) {
    const slug = c.repository?.full_name;
    if (!slug) continue;
    if (slug.startsWith(`${USER}/`)) continue; // own repo

    const bucket = get(slug);
    const msg = c.commit?.message || "";
    const match = msg.match(/\(#(\d+)\)/);
    if (match) {
      const prNum = parseInt(match[1], 10);
      if (bucket.prs.some((p) => p.number === prNum)) continue;
    }

    bucket.commits.push({
      sha: c.sha,
      url: c.html_url,
      date: c.commit?.author?.date,
    });
  }

  return map;
};

const renderContributions = (map) => {
  if (!map.size) return "_No merged open source contributions yet._";

  const repos = [...map.entries()].map(([slug, data]) => {
    const total = data.prs.length + data.commits.length;
    const latest = Math.max(
      ...data.prs.map((p) => +new Date(p.mergedAt) || 0),
      ...data.commits.map((c) => +new Date(c.date) || 0),
      0,
    );
    return { slug, data, total, latest };
  });

  repos.sort((a, b) => b.total - a.total || b.latest - a.latest);

  return repos
    .map(({ slug, data, total }) => {
      const repoUrl = `https://github.com/${slug}`;
      const label = `${total} contribution${total === 1 ? "" : "s"}`;
      const prLinks = data.prs
        .sort((a, b) => +new Date(b.mergedAt) - +new Date(a.mergedAt))
        .map((p) => `[#${p.number}](${p.url})`);
      const commitLinks = data.commits
        .sort((a, b) => +new Date(b.date) - +new Date(a.date))
        .map((c) => `[\`${c.sha.slice(0, 7)}\`](${c.url})`);
      const links = [...prLinks, ...commitLinks].slice(0, 8);
      const more = total > links.length ? `, +${total - links.length} more` : "";
      return `- **[${slug}](${repoUrl})**: ${label} (${links.join(", ")}${more})`;
    })
    .join("\n");
};

const replaceBlock = (md, marker, body) => {
  const re = new RegExp(`(<!-- ${marker}:START -->)[\\s\\S]*?(<!-- ${marker}:END -->)`);
  if (!re.test(md)) throw new Error(`Marker ${marker} not found`);
  return md.replace(re, `$1\n${body}\n$2`);
};

const main = async () => {
  const config = JSON.parse(await readFile("projects.json", "utf8"));
  const projects = (await Promise.all(config.projects.map(fetchProject))).filter(Boolean);
  const excludeRepos = new Set(config.excludeRepos || []);

  const [allPRs, authored, coauthored] = await Promise.all([
    fetchAllUserPRs(),
    fetchCommits(`author:${USER} -user:${USER}`),
    fetchCommits(`"<${EMAIL}>" -user:${USER}`),
  ]);

  const mergedPRs = allPRs.filter((p) => p.pull_request?.merged_at);
  const closedUnmerged = allPRs.filter(
    (p) => p.state === "closed" && !p.pull_request?.merged_at,
  );
  const contributedRepos = new Set(allPRs.map((p) => slugFromUrl(p.repository_url)));

  const siblings = (await Promise.all(closedUnmerged.map(findMergedSibling))).filter(
    Boolean,
  );

  const commitsBySha = new Map();
  for (const c of [...authored, ...coauthored]) commitsBySha.set(c.sha, c);

  // Whitelist commits to repos where the user has actually opened a PR.
  // Drops downstream forks that pulled the user's commits via co-author trailer.
  const filteredCommits = [...commitsBySha.values()].filter((c) =>
    contributedRepos.has(c.repository?.full_name),
  );

  // Dedupe: a sibling PR might already be in mergedPRs if user is a co-author.
  const seenPRKeys = new Set(
    mergedPRs.map((p) => `${slugFromUrl(p.repository_url)}#${p.number}`),
  );
  const newSiblings = siblings.filter(
    (s) => !seenPRKeys.has(`${slugFromUrl(s.repository_url)}#${s.number}`),
  );

  const map = buildContributionMap([...mergedPRs, ...newSiblings], filteredCommits);
  for (const slug of [...map.keys()]) {
    if (excludeRepos.has(slug)) map.delete(slug);
  }

  let md = await readFile("README.md", "utf8");
  md = replaceBlock(md, "PROJECTS", renderProjects(projects));
  md = replaceBlock(md, "OSS_PRS", renderContributions(map));
  await writeFile("README.md", md);

  console.log(
    `Updated: ${projects.length} projects, ${mergedPRs.length} merged PRs, ${newSiblings.length} sibling-merged PRs, ${commitsBySha.size} unique commits across ${map.size} repos`,
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
