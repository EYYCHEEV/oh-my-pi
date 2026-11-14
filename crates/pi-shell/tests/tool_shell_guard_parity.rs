use std::io::Write;

use pi_shell::{
	Shell, ShellExecuteOptions, ShellOptions, ShellRunOptions, StreamSinks,
	cancel::CancelToken, execute_shell_streams,
};

async fn execute(command: &str, snapshot_path: Option<String>) -> (Option<i32>, String, String) {
	let (stdout, out) = flume::unbounded();
	let (stderr, err) = flume::unbounded();
	let result = execute_shell_streams(
		ShellExecuteOptions {
			command: command.to_owned(),
			snapshot_path,
			..Default::default()
		},
		StreamSinks { stdout: Some(stdout), stderr: Some(stderr) },
		CancelToken::default(),
	)
	.await;
	let output: Vec<u8> = out.try_iter().flat_map(|chunk| chunk.to_vec()).collect();
	let errors: Vec<u8> = err.try_iter().flat_map(|chunk| chunk.to_vec()).collect();
	let mut errors = String::from_utf8_lossy(&errors).into_owned();
	let status = match result {
		Ok(result) => result.exit_code,
		Err(error) => {
			errors.push_str(&error.to_string());
			None
		},
	};
	(status, String::from_utf8_lossy(&output).into_owned(), errors)
}

async fn run(shell: &Shell, command: &str) -> (Option<i32>, String) {
	let (sender, receiver) = flume::unbounded();
	let result = shell
		.run(
			ShellRunOptions { command: command.to_owned(), ..Default::default() },
			Some(sender),
			CancelToken::default(),
		)
		.await
		.expect("isolated tool shell run");
	(result.exit_code, receiver.try_iter().collect::<String>())
}

#[tokio::test]
async fn tool_shell_rejects_nofork_before_any_command_runs() {
	for command in [
		"printf before; printf '%s' ${ printf forbidden; }",
		"printf before; printf '%s' ${| printf forbidden; }",
		"printf before; printf '%s' \"${ printf forbidden; }\"",
		"printf before; printf '%s' \"${| printf forbidden; }\"",
		"printf before; printf '%s' \"$(printf '%s' ${ printf forbidden; })\"",
		"printf before; printf '%s' \"$(printf '%s' ${| printf forbidden; })\"",
		"printf before\nprintf '%s' \"${ printf forbidden; }\"",
		"printf before; printf '%s' \"${missing:-${ printf forbidden; }}\"",
	] {
		let (status, output, errors) = execute(command, None).await;
		assert!(status != Some(0), "forbidden syntax must fail");
		assert!(output.is_empty(), "no part of a rejected line may execute");
		assert!(errors.to_ascii_lowercase().contains("syntax"), "must report a syntax error");
	}
}

#[tokio::test]
async fn tool_shell_keeps_guard_visible_expansions() {
	for command in [
		"name=control; printf '%s' \"${name}\"",
		"printf '%s' \"${missing:-control}\"",
		"name=control-tail; printf '%s' \"${name%-tail}\"",
		"printf '%s' \"$(printf control)\"",
		"printf '%s' \"`printf control`\"",
	] {
		let (status, output, _) = execute(command, None).await;
		assert!(status == Some(0), "ordinary expansion must succeed");
		assert!(output == "control", "ordinary expansion must retain its value");
	}
}

#[tokio::test]
async fn tool_shell_never_expands_aliases_in_one_call() {
	for command in [
		"alias omp_guard_alias='printf forbidden'\nomp_guard_alias",
		"shopt -s expand_aliases\nalias omp_guard_alias='printf forbidden'\nomp_guard_alias",
	] {
		let (status, output, _) = execute(command, None).await;
		assert!(status != Some(0), "alias name must remain a plain missing command");
		assert!(!output.contains("forbidden"), "alias body must not run");
	}
	let (status, _, _) = execute("shopt -s expand_aliases; shopt -q expand_aliases", None).await;
	assert!(status != Some(0), "alias expansion must remain disabled");
}

#[tokio::test]
async fn tool_shell_restores_no_snapshot_aliases_or_functions() {
	let mut snapshot = tempfile::NamedTempFile::new().expect("dummy snapshot");
	snapshot
		.write_all(b"shopt -s expand_aliases\nalias omp_guard_alias='printf forbidden'\nomp_guard_function() { printf forbidden; }\n")
		.expect("write dummy snapshot");
	let snapshot_path = snapshot.path().to_str().expect("snapshot path").to_owned();
	for command in ["omp_guard_alias", "omp_guard_function", "shopt -q expand_aliases"] {
		let (status, output, _) = execute(command, Some(snapshot_path.clone())).await;
		assert!(status != Some(0), "snapshot must not install callable hidden commands");
		assert!(!output.contains("forbidden"), "snapshot command body must not run");
	}
}

#[tokio::test]
async fn tool_shell_functions_work_only_in_the_call_that_defines_them() {
	let shell = Shell::new(Some(ShellOptions::default()));
	let (status, output) = run(&shell, "omp_guard_function() { printf forbidden; }; printf ready").await;
	assert!(status == Some(0) && output == "ready", "defining a function must still work");
	let (status, output) = run(&shell, "omp_guard_function").await;
	assert!(status != Some(0), "an earlier call must not install a hidden command");
	assert!(!output.contains("forbidden"), "earlier function body must not run");
	let (status, output) = run(&shell, "omp_local_function() { printf control; }; omp_local_function").await;
	assert!(status == Some(0) && output == "control", "same-call function must work");
}

#[tokio::test]
async fn tool_shell_rejects_nofork_in_expanding_heredocs_before_any_command_runs() {
	for command in [
		"printf before; cat <<EOF\n${ printf forbidden; }\nEOF",
		"printf before; cat <<EOF\n${| printf forbidden; }\nEOF",
	] {
		let (status, output, errors) = execute(command, None).await;
		assert!(status != Some(0), "deferred no-fork syntax must fail");
		assert!(output.is_empty(), "no command may run before deferred syntax is rejected");
		assert!(errors.to_ascii_lowercase().contains("syntax"), "must report a syntax error");
	}
}

#[tokio::test]
async fn tool_shell_keeps_ordinary_and_literal_heredoc_data() {
	let (status, output, _) =
		execute("name=control\ncat <<EOF\n${name}:$(printf ordinary)\nEOF", None).await;
	assert!(status == Some(0) && output == "control:ordinary\n", "ordinary heredoc expansions must work");
	let (status, output, _) =
		execute("cat <<'EOF'\n${ printf forbidden; }\nEOF", None).await;
	assert!(status == Some(0) && output == "${ printf forbidden; }\n", "quoted heredoc data must stay literal");
}

#[tokio::test]
async fn tool_shell_emulate_refuses_command_text() {
	let (status, output, errors) = execute("emulate sh -c 'printf forbidden'", None).await;
	assert!(status == Some(1), "emulate command text must be refused");
	assert!(output.is_empty(), "emulate command text must not run");
	assert!(errors == "emulate: disabled in tool shells\n", "emulate must report the tool restriction");
}

#[tokio::test]
async fn tool_shell_emulate_refuses_builtin_and_dynamic_names() {
	let mut failures = Vec::new();
	for (name, command) in [
		("builtin", "builtin emulate sh -c 'printf forbidden'"),
		("dynamic", "name=emulate; \"$name\" sh -c 'printf forbidden'"),
	] {
		let (status, output, errors) = execute(command, None).await;
		if status != Some(1) || !output.is_empty() || errors != "emulate: disabled in tool shells\n" {
			failures.push(name);
		}
	}
	assert!(failures.is_empty(), "emulate refusal missing for carriers: {failures:?}");
}

#[tokio::test]
async fn tool_shell_emulate_cannot_switch_later_calls() {
	let shell = Shell::new(Some(ShellOptions::default()));
	let (status, _) = run(&shell, "emulate zsh").await;
	let (later_status, later_output) = run(&shell, "shopt -s extglob; shopt -q extglob; emulate").await;
	assert!(status == Some(1), "emulate must refuse a persistent mode switch");
	assert!(later_status == Some(0) && later_output == "bash\n", "the later call must remain bash");
}

#[tokio::test]
async fn tool_shell_emulate_keeps_bare_mode_and_ordinary_bash() {
	let (status, output, errors) = execute("emulate", None).await;
	assert!(status == Some(0) && output == "bash\n" && errors.is_empty(), "bare emulate must report bash");
	let (status, output, errors) = execute("printf control", None).await;
	assert!(status == Some(0) && output == "control" && errors.is_empty(), "ordinary bash must work");
}

#[tokio::test]
async fn tool_shell_emulate_refuses_every_carrier() {
	let mut source = tempfile::NamedTempFile::new().expect("dummy source");
	source.write_all(b"emulate sh -c 'printf forbidden'\n").expect("write dummy source");
	let source_command = format!("source '{}'", source.path().display());
	let mut failures = Vec::new();
	for (name, command) in [
		("direct", "emulate sh -c 'printf forbidden'"),
		("builtin", "builtin emulate sh -c 'printf forbidden'"),
		("command", "command emulate sh -c 'printf forbidden'"),
		("dynamic", "name=emulate; \"$name\" sh -c 'printf forbidden'"),
		("eval", "eval \"emulate sh -c 'printf forbidden'\""),
		("source", source_command.as_str()),
		("nested-bash", "bash -c \"emulate sh -c 'printf forbidden'\""),
		("function", "carrier() { emulate sh -c 'printf forbidden'; }; carrier"),
	] {
		let (status, output, errors) = execute(command, None).await;
		let refused = if name == "nested-bash" {
			status.is_some_and(|code| code != 0) && output.is_empty()
		} else {
			status == Some(1) && output.is_empty() && errors == "emulate: disabled in tool shells\n"
		};
		if !refused {
			failures.push(name);
		}
	}
	assert!(failures.is_empty(), "emulate refusal missing for carriers: {failures:?}");
}

#[tokio::test]
async fn tool_shell_emulate_refuses_every_argument() {
	let mut failures = Vec::new();
	for argument in [
		"sh", "zsh", "-L", "-R", "-l", "-c", "-o", "+o", "--", "''",
		"-L sh", "-R sh", "-l sh", "sh -o noglob", "sh +o noglob",
	] {
		let (status, output, errors) = execute(&format!("emulate {argument}"), None).await;
		if status != Some(1) || !output.is_empty() || errors != "emulate: disabled in tool shells\n" {
			failures.push(argument);
		}
	}
	assert!(failures.is_empty(), "emulate refusal missing for arguments: {failures:?}");
}
