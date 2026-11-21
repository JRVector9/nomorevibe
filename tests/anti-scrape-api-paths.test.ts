import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { isSessionRead, PUBLIC_API_READS, requiresPublicApiSession } from "@/lib/anti-scrape/paths";

function handlerMethod(node: ts.Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent))
      && parent.name && ts.isIdentifier(parent.name)
      && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(parent.name.text)) return parent.name.text;
  }
}

it("공개 읽기 관문을 쓰는 모든 API 라우트와 브라우저 세션 경로가 일치한다", () => {
  const registered = Object.entries(PUBLIC_API_READS)
    .flatMap(([id, route]) => route.methods.map(method => [id, method, route.path].join(" ")));
  const guarded: string[] = [];

  const apiFiles = readdirSync("app/api", { recursive: true, encoding: "utf8" })
    .filter(file => /(^|\/)route\.[jt]s$/.test(file));

  for (const relative of apiFiles) {
    const file = "app/api/" + relative;
    const routePath = file.replace(/^app|\/route\.[jt]s$/g, "");
    const samplePath = routePath.replace(/\[[^\]]+\]/g, "sample");
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const guard = source.statements.flatMap(statement => {
      if (!ts.isImportDeclaration(statement)) return [];
      const bindings = statement.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements.filter(element => (element.propertyName ?? element.name).text === "guardPublicApiRead")
        : [];
    })[0];
    if (!guard) {
      expect(isSessionRead(samplePath, "GET"), file).toBe(false);
      expect(isSessionRead(samplePath, "POST"), file).toBe(false);
      continue;
    }

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === guard.name.text) {
        const id = node.arguments[1];
        const method = handlerMethod(node);
        if (!id || !ts.isStringLiteral(id) || !method) throw new Error("Expected a route ID and HTTP handler in " + file);
        guarded.push([id.text, method, routePath].join(" "));
        const requiresSession = requiresPublicApiSession(id.text);
        expect(requiresSession, file).toBe(id.text !== "session");
        expect(isSessionRead(samplePath, method), file).toBe(requiresSession);
        if (method === "GET") expect(isSessionRead(samplePath, "HEAD"), file).toBe(requiresSession);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  expect(guarded.sort()).toEqual(registered.sort());
});
