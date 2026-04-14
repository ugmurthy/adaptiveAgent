# Elixir Extended: Systems Programming, Networking & Communications

## Introduction

Welcome to **Elixir Extended**! This tutorial is designed for developers who have mastered the basics of Elixir (modules, functions, data types, data structures) and have built simple applications like chat examples. Here, we'll dive deep into **systems programming**, **networking**, and **communications** - areas where Elixir truly shines thanks to its foundation on the BEAM virtual machine.

### What You'll Learn

1. **TCP Servers** - Build robust, scalable TCP servers from scratch
2. **HTTP Servers** - Implement HTTP over TCP without frameworks
3. **GenServer Patterns** - Master process-based networking
4. **Distributed Systems** - Connect multiple nodes across your network
5. **Ports & External Resources** - Interact with external processes
6. **Real-world Applications** - Practical projects to solidify understanding

---

## Part 1: Building TCP Servers from Scratch

### Understanding `:gen_tcp`

Erlang's `:gen_tcp` module provides low-level TCP socket operations. Elixir gives us a clean interface to work with it.

#### Socket Options Explained

```elixir
:gen_tcp.listen(port, [
  :binary,           # Receive data as binaries instead of lists
  packet: :line,     # Read line-by-line (delimited by \n)
  active: false      # Block on recv until data available
])
```

Common options:
- `:binary` vs `:list` - Binary is more efficient
- `packet: :line` - Line-delimited messages
- `packet: :http_bin` - HTTP request/response parsing
- `active: false` - Manual receive (blocking)
- `active: true` - Messages sent to process automatically
- `active: :once` - One message then returns to passive mode
- `reuseaddr: true` - Allow immediate port reuse after server restart

---

### Project 1: Simple Echo Server

Let's start with a basic echo server that reflects back whatever it receives.

```elixir
defmodule KVServer do
  use Application

  @doc """
  Starts accepting connections on the given port.
  """
  def accept(port) do
    {:ok, socket} = :gen_tcp.listen(
      port,
      [:binary, packet: :line, active: false]
    )
    
    IO.puts("Accepting connections on port #{port}")
    loop_acceptor(socket)
  end

  defp loop_acceptor(socket) do
    {:ok, client} = :gen_tcp.accept(socket)
    serve(client)
    loop_acceptor(socket)
  end

  defp serve(socket) do
    socket
    |> read_line()
    |> write_line(socket)
    serve(socket)
  end

  defp read_line(socket) do
    {:ok, data} = :gen_tcp.recv(socket, 0)
    data
  end

  defp write_line(line, socket) do
    :gen_tcp.send(socket, line)
  end

  # Application callbacks
  def start(_type, _args) do
    children = [worker(__MODULE__, :accept, [4040])]
    Supervisor.start_link(children, strategy: :one_for_one)
  end
end
```

**Test it:**
```bash
# Terminal 1: Start the server
iex -S mix

# Terminal 2: Connect with telnet
telnet localhost 4040
```

Type anything and see it echoed back!

---

### Project 2: Scalable Echo Server with Task.Supervisor

The problem with the above server: it can only handle one client at a time. When serving one client, it can't accept new connections.

**Solution:** Spawn a separate process for each client using `Task.Supervisor`.

```elixir
defmodule KVServer do
  use Application

  def start(_type, _args) do
    import Supervisor.Spec

    children = [
      supervisor(Task.Supervisor, [[name: KVServer.TaskSupervisor]]),
      worker(Task, [KVServer, :accept, [4040]])
    ]

    opts = [strategy: :one_for_one, name: KVServer.Supervisor]
    Supervisor.start_link(children, opts)
  end

  def accept(port) do
    {:ok, socket} = :gen_tcp.listen(
      port,
      [:binary, packet: :line, active: false]
    )
    
    IO.puts("Accepting connections on port #{port}")
    loop_acceptor(socket)
  end

  defp loop_acceptor(socket) do
    {:ok, client} = :gen_tcp.accept(socket)
    
    # Spawn a temporary task to serve this client
    Task.Supervisor.start_child(
      KVServer.TaskSupervisor,
      fn -> serve(client) end
    )
    
    loop_acceptor(socket)
  end

  defp serve(socket) do
    case :gen_tcp.recv(socket, 0) do
      {:ok, data} ->
        :gen_tcp.send(socket, data)
        serve(socket)
      
      {:error, :closed} ->
        IO.puts("Client disconnected")
        :ok
    end
  end
end
```

**Key improvements:**
- Multiple concurrent clients
- Each client in its own process
- Client disconnection doesn't crash the server
- Tasks are temporary (cleaned up automatically)

**Test with multiple clients:**
```bash
# Open 3 terminals with telnet
telnet localhost 4040
```

Each connection works independently!

---

### Project 3: TCP Server with GenServer Pattern

For more complex scenarios, integrate TCP sockets with GenServer for better state management.

```elixir
defmodule MyApp.Server do
  def start_link(port) do
    Task.start_link(__MODULE__, :accept, [port])
  end

  def accept(port) do
    {:ok, listen_socket} = :gen_tcp.listen(
      port,
      [:binary, packet: :line, active: :once, reuseaddr: true]
    )
    loop_acceptor(listen_socket)
  end

  defp loop_acceptor(listen_socket) do
    {:ok, socket} = :gen_tcp.accept(listen_socket)
    
    # Spawn a supervised client process
    {:ok, pid} = DynamicSupervisor.start_child(
      MyApp.ClientSupervisor,
      {MyApp.Client, socket}
    )
    
    # Set the controlling process for active mode
    :gen_tcp.controlling_process(socket, pid)
    
    loop_acceptor(listen_socket)
  end
end

defmodule MyApp.Client do
  use GenServer

  def start_link(socket, opts \\ []) do
    GenServer.start_link(__MODULE__, socket, opts)
  end

  def init(socket) do
    # Switch to active mode - data arrives as messages
    :gen_tcp.setopts(socket, [active: true])
    {:ok, %{socket: socket}}
  end

  # Handle incoming TCP data
  def handle_info({:tcp, _socket, data}, state) do
    # Process the data
    response = process_data(data)
    
    # Send response back
    :gen_tcp.send(state.socket, response)
    
    {:noreply, state}
  end

  # Handle client disconnection
  def handle_info({:tcp_closed, _socket}, state) do
    IO.puts("Client disconnected")
    {:stop, :normal, state}
  end

  # Handle TCP errors
  def handle_info({:tcp_error, _socket, _reason}, state) do
    {:stop, :normal, state}
  end

  # Public API to send data to client
  def send(pid, data) do
    GenServer.cast(pid, {:send, data})
  end

  def handle_cast({:send, data}, %{socket: socket} = state) do
    :gen_tcp.send(socket, data)
    {:noreply, state}
  end

  defp process_data(data) when is_binary(data) do
    "Echo: #{data}"
  end
end
```

**Supervisor setup:**
```elixir
defmodule MyApp.Supervisor do
  use Supervisor

  def start_link(args) do
    Supervisor.start_link(__MODULE__, args)
  end

  def init(_args) do
    children = [
      {MyApp.Server, 8080},
      {DynamicSupervisor, strategy: :one_for_one, name: MyApp.ClientSupervisor}
    ]
    
    Supervisor.init(children, strategy: :one_for_one)
  end
end
```

**Why this pattern?**
- Clean separation between acceptor and handlers
- Active mode eliminates polling
- GenServer lifecycle management
- Easy to add state per connection

---

## Part 2: Building HTTP Servers

### Understanding HTTP over TCP

HTTP is just text over TCP. Let's build a minimal HTTP server to understand what frameworks do under the hood.

### Project 4: Minimal HTTP Server

```elixir
defmodule Http do
  require Logger

  def start_link(port: port) do
    {:ok, socket} = :gen_tcp.listen(
      port,
      active: false,
      packet: :http_bin,
      reuseaddr: true
    )
    
    Logger.info("Accepting connections on port #{port}")
    {:ok, spawn_link(Http, :accept, [socket])}
  end

  def accept(socket) do
    {:ok, request} = :gen_tcp.accept(socket)
    
    spawn(fn ->
      body = "Hello world! The time is #{Time.to_string(Time.utc_now())}"
      
      response = """
      HTTP/1.1 200\r
      Content-Type: text/html\r
      Content-Length: #{byte_size(body)}\r
      \r
      #{body}
      """
      
      send_response(request, response)
    end)
    
    accept(socket)
  end

  def send_response(socket, response) do
    :gen_tcp.send(socket, response)
    :gen_tcp.close(socket)
  end

  def child_spec(opts) do
    %{id: Http, start: {Http, :start_link, [opts]}}
  end
end
```

**HTTP Response Structure:**
```
HTTP/1.1 200\r\n          <- Status line
Content-Type: text/html\r\n <- Headers
Content-Length: 50\r\n     <- More headers
\r\n                        <- Empty line separates headers from body
Hello World!                <- Body
```

---

### Project 5: HTTP Server with Plug Integration

Now let's make our server work with Plug applications!

```elixir
defmodule CurrentTime do
  import Plug.Conn

  def init(options), do: options

  def call(conn, _opts) do
    conn
    |> put_resp_content_type("text/html")
    |> send_resp(200, "Hello world! The time is #{Time.to_string(Time.utc_now())}")
  end
end

defmodule Http.PlugAdapter do
  def dispatch(request, plug) do
    %Plug.Conn{
      adapter: {Http.PlugAdapter, request},
      owner: self()
    }
    |> plug.call([])
  end

  def send_resp(socket, status, headers, body) do
    response = "HTTP/1.1 #{status}\r\n#{headers(headers)}\r\n#{body}"
    Http.send_response(socket, response)
    {:ok, nil, socket}
  end

  defp headers(headers) do
    Enum.reduce(headers, "", fn {key, value}, acc ->
      acc <> key <> ": " <> value <> "\r\n"
    end)
  end

  def child_spec(plug: plug, port: port) do
    %{
      id: Http.PlugAdapter,
      start: {Http, :start_link, [port: port, dispatch: &dispatch(&1, plug)]}
    }
  end
end
```

**Request Parsing:**
```elixir
defmodule Http do
  # ... previous code ...

  def read_request(request, acc \\ %{headers: []}) do
    case :gen_tcp.recv(request, 0) do
      {:ok, {:http_request, :GET, {:abs_path, full_path}, _}} ->
        read_request(request, Map.put(acc, :full_path, full_path))
      
      {:ok, :http_eoh} ->
        acc
      
      {:ok, {:http_header, _, key, _, value}} ->
        read_request(
          request,
          Map.put(acc, :headers, [{String.downcase(to_string(key)), value} | acc.headers])
        )
      
      {:ok, _line} ->
        read_request(request, acc)
    end
  end
end
```

**Full Adapter with Request Parsing:**
```elixir
defmodule Http.PlugAdapter do
  def dispatch(request, plug) do
    %{full_path: full_path} = Http.read_request(request)
    
    %Plug.Conn{
      adapter: {Http.PlugAdapter, request},
      owner: self(),
      path_info: path_info(full_path),
      query_string: query_string(full_path)
    }
    |> plug.call([])
  end

  defp path_info(full_path) do
    [path | _] = String.split(full_path, "?")
    path |> String.split("/") |> Enum.reject(&(&1 == ""))
  end

  defp query_string([_]), do: ""
  
  defp query_string([_, query_string]), do: query_string
  
  defp query_string(full_path) do
    full_path
    |> String.split("?")
    |> query_string
  end
end
```

**Application Setup:**
```elixir
defmodule Http.Application do
  use Application

  def start(_type, _args) do
    children = [
      {Http.PlugAdapter, plug: CurrentTime, port: 8080}
    ]
    
    opts = [strategy: :one_for_one, name: Http.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
```

**Test it:**
```bash
mix run --no-halt
curl http://localhost:8080
```

---

## Part 3: Distributed Systems

Elixir inherits Erlang's powerful distribution capabilities. Let's explore building distributed applications.

### Starting Distributed Nodes

```bash
# Node 1 (short name - local network only)
iex --sname node1 --cookie mysecret

# Node 2
iex --sname node2 --cookie mysecret

# Production (long names with hostnames)
iex --name node1@server1.example.com --cookie prod_secret
iex --name node2@server2.example.com --cookie prod_secret
```

### Connecting Nodes

```elixir
# From node1, connect to node2
Node.connect(:"node2@hostname")
# => true

# List all connected nodes
Node.list()
# => [:"node2@hostname"]

# Check current node
Node.self()
# => :"node1@hostname"

# Ping a node
Node.ping(:"node2@hostname")
# => :pong
```

---

### Project 6: Global Process Registration

Use `:global` for cluster-wide singleton services.

```elixir
defmodule ClusterSingleton do
  use GenServer

  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: {:global, name})
  end

  def get_state(name \\ __MODULE__) do
    GenServer.call({:global, name}, :get_state)
  end

  def update_state(name \\ __MODULE__, value) do
    GenServer.cast({:global, name}, {:update, value})
  end

  @impl true
  def init(opts) do
    initial_state = Keyword.get(opts, :initial_state, %{})
    {:ok, initial_state}
  end

  @impl true
  def handle_call(:get_state, _from, state) do
    {:reply, state, state}
  end

  @impl true
  def handle_cast({:update, value}, state) do
    {:noreply, Map.merge(state, value)}
  end
end
```

**Usage across nodes:**
```elixir
# On any node in the cluster
ClusterSingleton.update_state(%{counter: 42})
ClusterSingleton.get_state()
# => %{counter: 42}
```

---

### Project 7: Process Groups with :pg

For multiple processes sharing a role (worker pools, pub/sub):

```elixir
defmodule EventBroadcaster do
  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @impl true
  def init(opts) do
    groups = Keyword.get(opts, :groups, [:events])
    
    Enum.each(groups, fn group ->
      :pg.join(group, self())
    end)
    
    {:ok, %{groups: groups}}
  end

  # Broadcast to all members of a group
  def broadcast(group, message) do
    pids = :pg.get_members(group)
    Enum.each(pids, fn pid ->
      send(pid, {:broadcast, message})
    end)
    {:ok, length(pids)}
  end

  # Send to random member (load balancing)
  def send_to_one(group, message) do
    case :pg.get_members(group) do
      [] -> {:error, :no_members}
      pids ->
        pid = Enum.random(pids)
        send(pid, {:direct, message})
        {:ok, pid}
    end
  end

  @impl true
  def handle_info({:broadcast, message}, state) do
    IO.puts("Received broadcast: #{inspect(message)}")
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, %{groups: groups}) do
    Enum.each(groups, fn group ->
      :pg.leave(group, self())
    end)
  end
end
```

---

### Project 8: Distributed Cache with Sharding

A cache that distributes keys across nodes using consistent hashing:

```elixir
defmodule DistributedCache do
  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get(key) do
    node = get_node_for_key(key)
    GenServer.call({__MODULE__, node}, {:get, key})
  end

  def put(key, value, ttl \\ :infinity) do
    node = get_node_for_key(key)
    GenServer.call({__MODULE__, node}, {:put, key, value, ttl})
  end

  def delete(key) do
    node = get_node_for_key(key)
    GenServer.call({__MODULE__, node}, {:delete, key})
  end

  defp get_node_for_key(key) do
    nodes = [Node.self() | Node.list()] |> Enum.sort()
    node_count = length(nodes)
    index = :erlang.phash2(key, node_count)
    Enum.at(nodes, index)
  end

  @impl true
  def init(_opts) do
    table = :ets.new(:cache, [:set, :protected])
    schedule_cleanup()
    {:ok, %{table: table}}
  end

  @impl true
  def handle_call({:get, key}, _from, %{table: table} = state) do
    result = case :ets.lookup(table, key) do
      [{^key, value, expires_at}] ->
        if expires_at == :infinity or expires_at > System.monotonic_time(:millisecond) do
          {:ok, value}
        else
          :ets.delete(table, key)
          {:error, :not_found}
        end
      [] ->
        {:error, :not_found}
    end
    {:reply, result, state}
  end

  @impl true
  def handle_call({:put, key, value, ttl}, _from, %{table: table} = state) do
    expires_at = case ttl do
      :infinity -> :infinity
      ms when is_integer(ms) -> System.monotonic_time(:millisecond) + ms
    end
    :ets.insert(table, {key, value, expires_at})
    {:reply, :ok, state}
  end

  @impl true
  def handle_call({:delete, key}, _from, %{table: table} = state) do
    :ets.delete(table, key)
    {:reply, :ok, state}
  end

  @impl true
  def handle_info(:cleanup, %{table: table} = state) do
    now = System.monotonic_time(:millisecond)
    :ets.select_delete(table, [
      {{:_, :_, :"$1"},
       [{"=/=", :"$1", :infinity}, {"<", :"$1", now}],
       [true]}
    ])
    schedule_cleanup()
    {:noreply, state}
  end

  defp schedule_cleanup do
    Process.send_after(self(), :cleanup, 60_000)
  end
end
```

---

### Project 9: Partition Detection and Handling

Monitor cluster topology changes:

```elixir
defmodule PartitionDetector do
  use GenServer
  require Logger

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    :net_kernel.monitor_nodes(true, [node_type: :visible])
    {:ok, %{known_nodes: MapSet.new(Node.list())}}
  end

  @impl true
  def handle_info({:nodeup, node, _info}, state) do
    Logger.info("Node joined cluster: #{node}")
    handle_node_join(node)
    {:noreply, %{state | known_nodes: MapSet.put(state.known_nodes, node)}}
  end

  @impl true
  def handle_info({:nodedown, node, _info}, state) do
    Logger.warning("Node left cluster: #{node}")
    handle_node_leave(node)
    {:noreply, %{state | known_nodes: MapSet.delete(state.known_nodes, node)}}
  end

  defp handle_node_join(node) do
    # Sync state with rejoined node
    :ok
  end

  defp handle_node_leave(node) do
    # Handle failover
    :ok
  end
end
```

---

### Automatic Clustering with libcluster

For production, use libcluster for automatic node discovery:

**mix.exs:**
```elixir
defp deps do
  [
    {:libcluster, "~> 3.3"}
  ]
end
```

**Kubernetes DNS Strategy:**
```elixir
defmodule MyApp.Application do
  use Application

  def start(_type, _args) do
    topologies = [
      k8s: [
        strategy: Cluster.Strategy.Kubernetes.DNS,
        config: [
          service: "myapp-headless",
          namespace: System.get_env("POD_NAMESPACE", "default"),
          application_name: "myapp",
          polling_interval: 5_000
        ]
      ]
    ]

    children = [
      {Cluster.Supervisor, [topologies, [name: MyApp.ClusterSupervisor]]},
      MyApp.Supervisor
    ]

    Supervisor.start_link(children, strategy: :one_for_one)
  end
end
```

**Gossip Strategy (Local Development):**
```elixir
topologies = [
  gossip: [
    strategy: Cluster.Strategy.Gossip,
    config: [
      multicast_addr: "230.1.1.1",
      port: 45892,
      if_addr: "0.0.0.0",
      broadcast_period: 1_000,
      secret: "my_cluster_secret"
    ]
  ]
]
```

---

## Part 4: Ports and External Resources

Ports allow Elixir to communicate with external processes.

### Basic Port Usage

```elixir
# Spawn an external command
port = Port.open({:spawn, "cat"}, [:binary])

# Send data
send(port, {self(), {:command, "hello"}})
send(port, {self(), {:command, "world"}})

# Receive output
flush()
# {#Port<0.1444>, {:data, "hello"}}
# {#Port<0.1444>, {:data, "world"}}

# Close the port
send(port, {self(), :close})
```

### Using spawn_executable (Recommended)

```elixir
path = System.find_executable("echo")
port = Port.open(
  {:spawn_executable, path},
  [:binary, args: ["hello world"]]
)

flush()
# {#Port<0.1380>, {:data, "hello world\n"}}
```

### Project 10: Managing External Commands

```elixir
defmodule ExternalCommand do
  use GenServer

  def start_link(command, args \\ []) do
    GenServer.start_link(__MODULE__, [command, args])
  end

  def execute(pid, input) do
    GenServer.call(pid, {:execute, input})
  end

  @impl true
  def init([command, args]) do
    port = Port.open(
      {:spawn_executable, command},
      [:binary, args: args, stdin: :binary, stdout: :binary]
    )
    
    {:ok, %{port: port, buffer: ""}}
  end

  @impl true
  def handle_call({:execute, input}, from, %{port: port} = state) do
    Port.command(port, input <> "\n")
    {:reply, :ok, %{state | caller: from}}
  end

  @impl true
  def handle_info({port, {:data, data}}, %{port: port, caller: caller} = state) do
    # Forward output to caller
    send(caller, {:output, data})
    {:noreply, %{state | buffer: state.buffer <> binary_part(data, 0, byte_size(data))}}
  end

  def handle_info({port, {:data, data}}, %{port: port} = state) do
    {:noreply, %{state | buffer: state.buffer <> binary_part(data, 0, byte_size(data))}}
  end

  @impl true
  def terminate(_reason, %{port: port}) do
    Port.close(port)
  end
end
```

---

## Part 5: Advanced Topics

### CRDTs for Conflict-Free Replication

Grow-only counter example:

```elixir
defmodule GCounter do
  defstruct counts: %{}

  def increment(%GCounter{counts: counts} = counter, amount \\ 1) do
    node = Node.self()
    current = Map.get(counts, node, 0)
    %GCounter{counter | counts: Map.put(counts, node, current + amount)}
  end

  def value(%GCounter{counts: counts}) do
    counts |> Map.values() |> Enum.sum()
  end

  def merge(%GCounter{counts: c1}, %GCounter{counts: c2}) do
    merged = Map.merge(c1, c2, fn _node, v1, v2 -> max(v1, v2) end)
    %GCounter{counts: merged}
  end
end
```

---

## Practice Projects

Build these to solidify your understanding:

1. **Multi-room Chat Server** - TCP server with room support
2. **REST API Server** - HTTP server implementing CRUD operations
3. **Distributed Job Queue** - Workers pulling jobs from a shared queue
4. **Metrics Collector** - UDP server collecting metrics from multiple sources
5. **Load Balancer** - Distribute requests across backend servers
6. **Simple Database** - Persistent key-value store with replication

---

## Recommended Resources

### Books
- **"Network Programming in Elixir and Erlang"** by Andrea Leopardi - Comprehensive coverage of TCP, UDP, TLS, HTTP, DNS, WebSockets
- **"Build Your Own Web Framework in Elixir"** by Adi Iyengar - GitHub: https://github.com/PacktPublishing/Build-Your-Own-Web-Framework-in-Elixir

### Articles & Tutorials
- Official Elixir Guide: https://elixir-lang.readthedocs.io/en/latest/mix_otp/8.html
- Rob Golding's TCP GenServer: http://www.robgolding.com/blog/2019/05/21/tcp-genserver-elixir/
- AppSignal HTTP Server Tutorial: https://blog.appsignal.com/2019/01/22/serving-plug-building-an-elixir-http-server.html
- Distributed Systems Guide: https://oneuptime.com/blog/post/2026-02-03-elixir-distributed-systems/view

### Libraries
- **libcluster** - Automatic clustering strategies
- **Ranch** - High-performance TCP socket manager
- **Cowboy** - Production HTTP server
- **Phoenix Channels** - WebSocket framework

---

## Conclusion

You've now explored Elixir's powerful capabilities in systems programming and networking. Remember:

1. **Start simple** - Understand `:gen_tcp` before using abstractions
2. **Leverage OTP** - Use supervisors, GenServers, and Task patterns
3. **Think distributed** - Elixir makes multi-node applications natural
4. **Handle failures** - Design for crashes and partitions
5. **Practice** - Build real projects to internalize concepts

The BEAM was built for telecom systems that couldn't afford downtime. That same reliability is available to every Elixir developer willing to embrace these patterns.

Happy coding! 🚀
