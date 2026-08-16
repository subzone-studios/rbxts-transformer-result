/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import ts from "typescript";

function isTryCall(node: ts.Expression): node is ts.CallExpression {
	return (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "$try" &&
		node.arguments.length === 1
	);
}

export default function transform() {
	return (context: ts.TransformationContext): ((file: ts.SourceFile) => ts.Node) => {
		const factory = context.factory;

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

		function transformBlock(node: ts.Block): ts.Block {
			const statements = new Array<ts.Statement>();

			for (const statement of node.statements) {
				if (ts.isVariableStatement(statement)) {
					statements.push(...transformVariableStatement(statement));
				} else {
					statements.push(ts.visitEachChild(statement, visitor, context) as ts.Statement);
				}
			}

			return factory.updateBlock(node, statements);
		}

		function visitor(node: ts.Node): ts.VisitResult<ts.Node> {
			if (ts.isBlock(node)) {
				return transformBlock(node);
			}

			return ts.visitEachChild(node, visitor, context);
		}

		return (file: ts.SourceFile) => ts.visitNode(file, visitor) as ts.SourceFile;
	};
}
