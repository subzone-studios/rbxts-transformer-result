import {} from "ts-expose-internals";
import ts from "typescript";

function isTryCall(node: ts.Expression): node is ts.CallExpression {
	return (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "$try" &&
		node.arguments.length === 1
	);
}

export default function (program: ts.Program) {
	return (context: ts.TransformationContext): ((file: ts.SourceFile) => ts.Node) => {
		const factory = context.factory;

		function transformStatements(statements: ts.NodeArray<ts.Statement>): ts.Statement[] {
			const output = new Array<ts.Statement>();

			for (const statement of statements) {
				if (ts.isVariableStatement(statement)) {
					output.push(...transformVariableStatement(statement));
				} else {
					output.push(ts.visitEachChild(statement, visitor, context) as ts.Statement);
				}
			}

			return output;
		}

		function transformVariableStatement(statement: ts.VariableStatement): ts.Statement[] {
			const output = new Array<ts.Statement>();

			for (const declaration of statement.declarationList.declarations) {
				const initializer = declaration.initializer;

				if (!initializer || !isTryCall(initializer)) {
					const transformed = ts.visitEachChild(declaration, visitor, context);

					output.push(
						factory.createVariableStatement(
							statement.modifiers,
							factory.createVariableDeclarationList([transformed], statement.declarationList.flags),
						),
					);

					continue;
				}

				const result = factory.createUniqueName("__try");

				// const __try = expression;
				output.push(
					factory.createVariableStatement(
						undefined,
						factory.createVariableDeclarationList(
							[
								factory.createVariableDeclaration(
									result,
									undefined,
									undefined,
									ts.visitNode(initializer.arguments[0], visitor) as ts.Expression,
								),
							],
							ts.NodeFlags.Const,
						),
					),
				);

				// if (__try.isErr()) {
				//     return __try as never;
				// }
				output.push(
					factory.createIfStatement(
						factory.createCallExpression(
							factory.createPropertyAccessExpression(result, "isErr"),
							undefined,
							[],
						),
						factory.createBlock(
							[
								factory.createReturnStatement(
									factory.createAsExpression(
										result,
										factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword),
									),
								),
							],
							true,
						),
					),
				);

				// const x = __try.unwrap();
				const value = factory.createCallExpression(
					factory.createPropertyAccessExpression(result, "unwrap"),
					undefined,
					[],
				);

				output.push(
					factory.createVariableStatement(
						statement.modifiers,
						factory.createVariableDeclarationList(
							[
								factory.updateVariableDeclaration(
									declaration,
									declaration.name,
									declaration.exclamationToken,
									declaration.type,
									value,
								),
							],
							statement.declarationList.flags,
						),
					),
				);
			}

			return output;
		}

		function visitor(node: ts.Node): ts.VisitResult<ts.Node> | undefined {
			if (
				ts.isImportDeclaration(node) &&
				ts.isStringLiteral(node.moduleSpecifier) &&
				node.moduleSpecifier.text === "rbxts-transformer-result"
			) {
				return undefined;
			}

			if (ts.isSourceFile(node)) {
				return factory.updateSourceFile(node, transformStatements(node.statements));
			}

			if (ts.isBlock(node)) {
				return factory.updateBlock(node, transformStatements(node.statements));
			}

			return ts.visitEachChild(node, visitor, context);
		}

		return (file: ts.SourceFile) => ts.visitNode(file, visitor) as ts.SourceFile;
	};
}
