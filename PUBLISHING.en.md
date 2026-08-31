# Release Workflow (v2.0.1+: Push Code, Auto Build)

Since v2.0.1, **local build / signing / upload of installers is no longer needed**. Just push code and create a tag —
GitHub Actions handles everything: build installer → certificate signing → upload to GitHub Release → sync to Gitee Release.

## One-Click Release (Recommended)

```cmd
node scripts/publish.mjs 2.1.0
```

This script automatically:
1. Bumps the version in `package.json`
2. Inserts a placeholder section at the top of `CHANGELOG.md` for this version (**manually add your changes before running, or run it first then edit — existing content won't be overwritten**)
3. `git commit` + `git tag v2.1.0`
4. Push `main` + tag to both **Gitee and GitHub**
5. Prompts you to open the Actions page to watch progress

After that, GitHub Actions (`.github/workflows/release.yml`) takes over:
- Runs on Windows: `npm ci` + `typecheck` + `electron-builder` to build the installer
- Signs with `build/yingxia-sign.pfx` + certificate password
- Uploads to GitHub Release (matching the tag)
- Creates a Gitee Release (body contains a GitHub download link — Gitee has no CI to build on its own)

## First-Time Setup: Configure Two GitHub Secrets

Open GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret Name | Value | Description |
|---|---|---|
| `CERT_PASSWORD` | Password for `yingxia-sign.pfx` | The password you set when importing this certificate to Windows; used by CI for signing |
| `GITEE_TOKEN` | Gitee personal access token | Used to create Gitee Releases automatically (generate at gitee.com → Personal Settings → Personal Access Tokens, enable `projects` permission) |

> Skipping `GITEE_TOKEN` won't break the GitHub build and release — Gitee sync is simply skipped.
> Missing `CERT_PASSWORD` won't fail the build either, but the installer will be unsigned (Windows will show "publisher unknown").

## Manual Release (Without Script)

```cmd
npm run typecheck
git add -A
git commit -m "v2.1.0: xxx"
git tag v2.1.0
git push https://github.com/mr-awei/yingxia-video-manager.git main v2.1.0
git push https://gitee.com/mr-awei/yingxia-video-manager.git main v2.1.0
```

## Build Progress

- GitHub Actions: `https://github.com/mr-awei/yingxia-video-manager/actions`
- When done, the installer appears automatically under GitHub Release (~ 5-8 minutes)

## FAQ

- **Why can't Gitee build automatically?** Gitee has no usable free CI (Gitee Go was discontinued for regular users). So the Gitee Release body is synced from GitHub Actions with a GitHub download link — click the link to download from GitHub.
- **Want to build locally anyway?** Still possible: `npm run pack`, then sign manually (`signtool sign /sha1 <certificate-fingerprint> /fd SHA256 /tr http://timestamp.sectigo.com /td SHA256 "release\YingXia Setup x.x.x.exe"`).
