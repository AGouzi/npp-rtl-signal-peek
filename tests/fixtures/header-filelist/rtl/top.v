`include "defs.vh"

module top(input wire clk, output wire out);
  sub u_sub(.clk(clk), .out(out));
endmodule
