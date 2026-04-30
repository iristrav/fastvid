import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";

async function startServer() {
  const app = express();
  const server = createServer(app);

  // 🔥 Auto detect juiste build map
  const distPublic = path.resolve(process.cwd(), "dist/public");
  const distRoot = path.resolve(process.cwd(), "dist");

  const staticPath = fs.existsSync(distPublic) ? distPublic : distRoot;

  console.log("Using static path:", staticPath);

  app.use(express.static(staticPath));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

startServer().catch(console.error);
