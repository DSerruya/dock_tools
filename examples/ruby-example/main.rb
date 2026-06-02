puts "Ruby example script started"
$stdout.flush

loop do
  ts = Time.now.strftime("%Y-%m-%d %H:%M:%S")
  puts "[#{ts}] Hello from Ruby — version 1.0"
  $stdout.flush
  sleep 10
end
