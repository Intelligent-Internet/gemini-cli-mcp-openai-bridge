git submodule update --init --recursive
cp -r mcp-server gemini-cli/packages/
(
  cd gemini-cli
  npm install
  npm run build
)
