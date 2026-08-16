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

type ReturnableFunction =
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction
	| ts.MethodDeclaration
	| ts.GetAccessorDeclaration;

function getContainingFunction(node: ts.Node): ReturnableFunction | undefined {
	let current = node.parent;

	while (current) {
		if (
			ts.isFunctionDeclaration(current) ||
			ts.isFunctionExpression(current) ||
			ts.isArrowFunction(current) ||
			ts.isMethodDeclaration(current) ||
			ts.isGetAccessorDeclaration(current)
		) {
			return current;
		}

		current = current.parent;
	}

	return undefined;
}

type DiagnosticContext = ts.TransformationContext & {
	addDiagnostic(diagnostic: ts.DiagnosticWithLocation): void;
};

function addError(context: ts.TransformationContext, node: ts.Node, messageText: string) {
	const file = node.getSourceFile();

	(context as DiagnosticContext).addDiagnostic({
		category: ts.DiagnosticCategory.Error,
		code: 90001,
		file,
		start: node.getStart(file),
		length: node.getWidth(file),
		messageText,
	});
}

export default function (program: ts.Program) {
	const checker = program.getTypeChecker();

	function getMethodReturnType(type: ts.Type, name: string, location: ts.Node): ts.Type | undefined {
		const property = type.getProperty(name);
		if (!property) {
			return undefined;
		}

		const propertyType = checker.getTypeOfSymbolAtLocation(property, location);

		const signature = propertyType.getCallSignatures()[0];
		if (!signature) {
			return undefined;
		}

		return checker.getReturnTypeOfSignature(signature);
	}

	function isResultLike(type: ts.Type, location: ts.Node): boolean {
		return (
			getMethodReturnType(type, "isErr", location) !== undefined &&
			getMethodReturnType(type, "unwrap", location) !== undefined &&
			getMethodReturnType(type, "unwrapErr", location) !== undefined &&
			getMethodReturnType(type, "expect", location) !== undefined &&
			getMethodReturnType(type, "expectErr", location) !== undefined
		);
	}

	function validateTryCall(call: ts.CallExpression, context: ts.TransformationContext): boolean {
		const func = getContainingFunction(call);

		if (!func) {
			addError(context, call, "$try() can only be used inside a function returning Result.");
			return false;
		}

		if (!func.type) {
			addError(context, call, "$try() requires the containing function to have an explicit Result return type.");
			return false;
		}

		const returnType = checker.getTypeFromTypeNode(func.type);

		if (!isResultLike(returnType, func.type)) {
			addError(
				context,
				call,
				`$try() can only be used inside a function returning Result; this function returns ${checker.typeToString(
					returnType,
				)}.`,
			);
			return false;
		}

		const argument = call.arguments[0];
		const argumentType = checker.getTypeAtLocation(argument);

		if (!isResultLike(argumentType, argument)) {
			// Usually TS should catch this through $try's declaration anyway.
			addError(context, call, "$try() argument must be a Result.");
			return false;
		}

		const inputError = getMethodReturnType(argumentType, "unwrapErr", argument);

		const outputError = getMethodReturnType(returnType, "unwrapErr", func.type);

		if (!inputError) {
			addError(context, call, `No method return type for argument ${argument} (${argumentType})`);
			return false;
		}

		if (!outputError) {
			addError(context, call, `No method return type for output return type ${returnType} (${func.type})`);
			return false;
		}

		if (!checker.isTypeAssignableTo(inputError, outputError)) {
			addError(
				context,
				call,
				`Cannot propagate ${checker.typeToString(inputError)} into Result<_, ${checker.typeToString(
					outputError,
				)}>.`,
			);

			return false;
		}

		return true;
	}

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

				validateTryCall(initializer, context);

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
