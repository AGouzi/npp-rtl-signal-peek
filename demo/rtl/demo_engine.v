module demo_engine (
  input  wire       clk,
  input  wire       rst_n,
  input  wire       in_valid,
  input  wire [7:0] in_data,
  output wire       out_valid,
  output wire [7:0] out_data
);

  wire [7:0] mixed_data;
  reg  [7:0] stage_data;
  reg        stage_valid;

  demo_cell u_cell (
    .a (in_data),
    .b (stage_data),
    .y (mixed_data)
  );

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      stage_data  <= 8'h00;
      stage_valid <= 1'b0;
    end else begin
      stage_data  <= in_data;
      stage_valid <= in_valid;
    end
  end

  assign out_valid = stage_valid;
  assign out_data  = mixed_data;

endmodule
