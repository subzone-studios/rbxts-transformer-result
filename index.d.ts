/** @stub */
interface ResultLike<T, E> {
	isErr(): boolean;
	isOk(): boolean;
	expect(message: string): T;
	expectError(message: string): E;
	unwrap(): T;
	unwrapErr(): E;
}

export function $try<T, E>(result: ResultLike<T, E>): T;
