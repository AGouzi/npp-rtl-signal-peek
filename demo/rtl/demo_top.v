module demo_top (
  input  wire       clk,
  input  wire       rst_n,
  input  wire       in_valid,
  input  wire [7:0] in_data,
  output wire       out_valid,
  output wire [7:0] out_data
);

  wire       engine_valid;
  wire [7:0] engine_data;

  demo_engine u_engine (
    .clk        (clk),
    .rst_n      (rst_n),
    .in_valid   (in_valid),
    .in_data    (in_data),
    .out_valid  (engine_valid),
    .out_data   (engine_data)
  );

  assign out_valid = engine_valid;
  assign out_data  = engine_data;

endmodule
