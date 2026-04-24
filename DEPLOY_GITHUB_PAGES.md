# SecureX GitHub Pages Publish

## Option A: No Git Installed (Fastest)
1. Open [GitHub New Repository](https://github.com/new) and create a public repo named `securex-site`.
2. In the repo, click `Add file` -> `Upload files`.
3. Upload these files from this folder:
   - `index.html`
   - `styles.css`
   - `script.js`
4. Commit the upload.
5. Go to `Settings` -> `Pages`.
6. Under `Build and deployment`:
   - `Source`: `Deploy from a branch`
   - `Branch`: `main`
   - `Folder`: `/ (root)`
7. Save, then wait 1 to 3 minutes.
8. Your site URL will be: `https://<your-username>.github.io/securex-site/`

## Option B: With Git Installed
Run these commands in this folder:

```powershell
git init
git add .
git commit -m "SecureX redesign"
git branch -M main
git remote add origin https://github.com/<your-username>/securex-site.git
git push -u origin main
```

Then enable Pages in repo `Settings` -> `Pages` using `main` and `/ (root)`.

## Notes
- Keep this as a static site for fast GitHub Pages deploy.
- If you rename the repo, your Pages URL changes accordingly.
