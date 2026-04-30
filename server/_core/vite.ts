export function serveStatic(app: Express) {

  console.log("ROOT FILES:", fs.readdirSync(process.cwd()));

  const distRoot = path.resolve(process.cwd(), "dist");
  console.log("DIST EXISTS:", fs.existsSync(distRoot));

  if (fs.existsSync(distRoot)) {
    console.log("DIST CONTENT:", fs.readdirSync(distRoot));
  }

  // 👇 probeer eerst dist/public
  let distPath = path.resolve(process.cwd(), "dist/public");

  if (!fs.existsSync(distPath)) {
    console.log("dist/public NOT FOUND → trying dist instead");
    distPath = path.resolve(process.cwd(), "dist");
  }

  console.log("USING PATH:", distPath);

  app.use(express.static(distPath));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}
